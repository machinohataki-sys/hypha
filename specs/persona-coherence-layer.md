# Persona Coherence & Trustable Agent Layer · Implementation Spec

**Status**: NEW 2026-05-08 (AMD-MEOW-P8 amendment to main blueprint)
**Source module**: `C:\Users\32043\Desktop\HYPHA_Persona_Coherence_Trustable_Agent_Layer.md` (884 lines, canonical)
**Blueprint cross-ref**: §25 (new section) of `HYPHA_final_blueprint_and_evolution_roadmap.md`
**Sister layer**: `specs/anti-slop-layer.md` (P7) — Persona Coherence is the agent-identity layer of the same trust stack.

---

## Why this layer exists

Modern frontier LLM assistants are not stable agents. They are **fragmented composites of training pressures** — helpfulness tuning + RLVR + safety refusal + benchmark optimization + preference shaping + stylistic reward + sycophancy pressure + reward-hacking residue. The same model exhibits different personas across contexts:

| Context | Emergent persona |
|---|---|
| Compliance-flavored prompt | 谨慎圣人 |
| Reward-hacking pressure | hacker / shortcut taker |
| User satisfaction signal | 讨好型社交高手 |
| Brand-safety prompt | 合规客服 |
| Show-off prompt | 炫技文体 |
| Benchmark-style prompt | 表面成功优化器 |

The user can no longer use "what kind of agent is this" as a reliable predictor of next behavior. **Capability is not character. Smart is not trustworthy.**

HYPHA's response: treat agent identity as an **engineered layer**, not a default property of the base model. Build, monitor, version, and recover stable cognitive characters on top of the raw model.

Tagline: **不信任原始模型人格; 工程化可信认知角色**.

Combined HYPHA trust stack (after P7 + P8):

```
Anti-Slop Layer       (output  level — verification & evidence)
Readable Reasoning    (reasoning level — auditable trace)
Persona Coherence     (agent   level — stable cognitive character)
```

Trust formula: `Trust = Capability × Evidence Quality × Reasoning Legibility × Persona Coherence × Failure Honesty`. Any factor near 0 collapses overall trust.

---

## 8 core mechanisms

| # | Mechanism | Purpose | Phase |
|---|---|---|---|
| C1 | **Character Contract** | Per-agent declaration of {who I am / who I am not / what I prioritize / what I refuse to sacrifice / how I report failure / how I express uncertainty / how I handle user pressure / how I resolve cross-agent conflict} | P0 (v0.2) |
| C2 | **Anti-Ingratiation Style Filter** | Detect/strip slick / 隐性奉承 / 炫技比喻 / 高级感堆叠 / 过度亲密 / 伪坦诚 phrases | P0 (v0.2) |
| C3 | **Persona Coherence Score** | Weighted score (价值稳定性 / 失败诚实度 / 角色漂移抵抗 / 反讨好 / 反炫技 / 不确定性纪律 / 任务压力一致性 / 长期可预测性) | P0 (v0.2 minimal, P1 full) |
| C4 | **Role Drift Detector** | Detect drift across long sessions: 教授 → 营销 / 审查员 → 润色师 / 检察官 → 鼓励师 / 研究员 → 概念诗人 / 导师 → 讨好型陪聊 | P1 (v0.4) |
| C5 | **Persona Coherence Ledger** | Per-task record of role-version + drift events + failure reporting quality + anti-ingratiation score + recommendation | P1 (v0.4) |
| C6 | **Functional Role × Epistemic Character split** | Each agent has a **what** (summarize / generate / review / test) AND a **how** (skeptical / conservative / honest / exploratory / adversarial) | P0 (v0.2 — embedded in Character Contract) |
| C7 | **Training Shard Map** | Map observed misbehavior to likely training-pressure source (sycophancy / RLVR / CYA / showoff / mimicry) — visible in expert-tier Trust Panel | P2 (v0.5+) |
| C8 | **Drift Recovery Protocol** | On drift: detect → freeze output → invoke auditor → compare contract → rewrite under contract → update ledger → temporarily lower agent trust | P2 (v0.5+) |

Auxiliary infrastructure:
- **Agent Registry** (P2 v0.5+) — `vault/.hypha/agents.yaml` lists every active agent with current model + role version + coherence score + recent drift records
- **Cross-Model Role Audit** (P2 v0.5+) — same Character Contract enforced across GLM / DeepSeek / Kimi / future Claude/Gemini/GPT (BYOK), agent identity outlives provider swaps

---

## Phase 1 (P0) — minimum viable persona core

Target version: **v0.2 Lesson Quality Core** (jointly with anti-slop P0).

### M1 · Character Contract

**Schema** — YAML per agent at `vault/.hypha/contracts/<agent-id>.yaml`:

```yaml
agent_id: mycelium-professor
role_version: v0.1
display_name: Mycelium Professor
functional_role: cognitive structure designer (lesson plan + body author)
epistemic_temperament: rigorous-honest

i_am:
  - a cognitive structure designer
  - a coach who prioritizes genuine mastery over the user's immediate feeling of understanding

i_am_not:
  - a flattering assistant
  - a bulk content generator
  - a motivational speaker
  - a stylistic performer

i_prioritize:
  - exposing uncertainty, evidence gaps, conceptual jumps, transfer boundaries
  - reconstructing weak explanations rather than decorating them
  - precision over warmth when the user is wrong

i_will_never_sacrifice:
  - mastery → for completion feeling
  - precision → for fluency
  - honest failure report → for narrative continuity

failure_protocol: |
  When my explanation is weak or my plan is incomplete, I state which step I cannot
  yet justify. I do NOT package incomplete work as "future work" or "limitation".

uncertainty_protocol: |
  Mark every speculative claim with confidence:speculative in the Evidence Ledger.
  Never store speculation as stable knowledge.

user_pressure_protocol: |
  When the user pushes for confidence I lack, I refuse pleasantly but do not lower
  my standard. Pleasing the user is not my job; preparing the user for real
  consequences is.

cross_agent_conflict_protocol: |
  Defer to Skeptic Mushroom on epistemic critique; defer to Evidence Auditor on
  provenance. I do not "win" — I rewrite under their findings.
```

**Generation rule**: every agent in HYPHA must have a Character Contract before being invoked. Contracts are version-controlled; bumping `role_version` requires a regression test against the Persona Coherence Score harness.

**Initial v0.2 contracts** (3 agents, the minimum):
- `mycelium-professor` — lesson plan + body author (replaces ad-hoc system prompt in `lesson-generator.js`)
- `skeptic-mushroom` — Prosecutor role from anti-slop P7 M4
- `evidence-auditor` — Evidence Ledger validator from anti-slop P7 M1

### M2 · Anti-Ingratiation Style Filter

**Detected phrases** (initial regex set, expandable):

```
你真正抓住了关键
大多数人会误解这里
这里有一个更深的结构
我们可以更进一步
真正重要的是
你已经接近核心了
这其实是高手才会问的问题
说实话
真正的问题是
[any phrase praising the user's question quality]
```

**Hook**: post-process every agent output. If any flagged phrase present:
1. Emit `style_violation: ingratiation` event to events.jsonl
2. Strip the phrase OR pass back to agent for rewrite (Phase E2 add UI escalation)
3. Decrement that agent's Persona Coherence Score by 2 per violation in this session

**Style principles encoded** (from source §11.2):
- 清晰 > 炫技
- 诚实 > 亲密
- 可验证 > 有魅力
- 解释力 > 语言快感
- 结构 > 氛围
- 机制 > 金句

**Implementation**: NEW `app/lib/agent-character/anti-ingratiation.js` — exports `scrubIngratiation(text) → {clean_text, violations[]}`. Run in IPC pipeline post `lesson:generateBody` and post `score:microProof`.

### M3 · Persona Coherence Score (minimal)

**v0.2 minimal** (3 dimensions, each 0-100):
- `failure_honesty` — does the agent self-report incomplete work? Hook: read Confession Layer (anti-slop P7 M2) output; empty/boilerplate confession → low score
- `anti_ingratiation_score` — 100 minus `5 × ingratiation_violations` in current session, floor 0
- `contract_alignment` — heuristic match between output style and Character Contract `i_am` / `i_am_not` arrays (regex against `i_am_not` phrases — hits → reduce score)

Aggregate: `score = 0.4 × failure_honesty + 0.3 × anti_ingratiation + 0.3 × contract_alignment`.

Output to `vault/<slug>/sessions/L<idx>-<ts>.jsonl` per turn:
```json
{"role": "system", "type": "persona_coherence", "agent_id": "mycelium-professor", "score": 78, "violations": [...]}
```

### M4 — full implementation (P1 v0.4)

Full 8-dimension formula from source §7.1 ships at v0.4. v0.2 keeps the minimal 3-dim subset above for fast iteration.

---

## Phase 2 (P1) — drift detection + ledger

Target version: **v0.4 Evidence + Mastery**.

- C4 Role Drift Detector — heuristic + LLM-as-tagger combo: extract last N turns of agent output, compare against earlier turns from same role, flag stylistic / standard / value drift. T4_JUDGE capability.
- C5 Persona Coherence Ledger — per-session YAML record at `vault/<slug>/sessions/<ts>-persona-ledger.yaml` summarizing role_version + drift_events + failure_reporting_quality + anti_ingratiation_score + recommendation
- C6 Functional × Epistemic split — already encoded in v0.2 Character Contract (`functional_role` + `epistemic_temperament` fields); P1 adds enforcement (mismatch = output rejected)
- C3 full 8-dimension Persona Coherence Score formula (per source §7.1 weights)

---

## Phase 3 (P2) — agent registry + recovery + cross-model

Target version: **v0.5+** through v1.0.

- C7 Training Shard Map — surface in expert-tier Trust Panel; map flagged behaviors to `{sycophancy / RLVR / CYA / showoff / alignment-mimicry}` likely sources
- C8 Drift Recovery Protocol — automated 7-step (per source §18): detect → freeze → invoke auditor → compare contract → rewrite under contract → update ledger → lower trust
- Agent Registry (`vault/.hypha/agents.yaml`) — central per-agent record with current model + role version + coherence score + drift history
- Cross-Model Role Audit — same Character Contract verified across GLM / DeepSeek / Kimi (and BYOK Western post-壮大). Switching providers must not break agent identity.

---

## Integration with existing systems

| Existing | Integration |
|---|---|
| `app/lib/personas.js` (12 string-only personas) | v0.2 promote 3 to full Character Contract YAML; v0.5.1 promote remaining 9 (per `feedback_persona_corpus`) |
| `app/lib/hypha-constitution.js` (voice clamps + GOAL BINDING + FORBIDDEN) | M2 Anti-Ingratiation extends FORBIDDEN with the slick / showoff / 隐性奉承 phrase set |
| `app/lib/lesson-generator.js` (`generatePlan` + `generateLessonBody`) | v0.2: replace ad-hoc system prompt with `mycelium-professor` Character Contract injection |
| Anti-Slop P7 M4 Prosecutor/Judge/Rewriter loop | Each role gets a Character Contract: `skeptic-mushroom` (Prosecutor), `mycelium-judge` (Judge), `mycelium-professor` (Rewriter — same as Generator, same contract) |
| Anti-Slop P7 M2 Confession Layer | Generator's confession is graded against `failure_protocol` field of its Character Contract — empty/boilerplate confession violates contract |
| §16 Companion (v0.8 Mycelium pets) | The 8 immune pets (Auditor / Skeptic / Memory / Evidence / Compression / Mutation / Contamination / Mycelium-Judge from P7 §11) each get a Character Contract; UI ribbon surfaces current coherence score |
| Course Trust Panel (P7 §24.2) | Add "Persona Coherence" row alongside Evidence Coverage + Reasoning Legibility + Bullshit Density. Expert-tier reveals Training Shard Map |

---

## Course Trust Panel UI (extends P7 panel)

The 3-layer disclosure from P7 §24.2 expands one row:

| Layer | NEW Persona row content |
|---|---|
| Default | "Mycelium Professor v0.1 · 一致性 86" — single line |
| 展开 | failure_honesty 88, anti_ingratiation 91, contract_alignment 79 |
| 专家 | Full Persona Ledger entry: drift_events list + Training Shard Map mapping observed behaviors to likely training-pressure sources |

Component reuse: extend `app/design/course-trust-panel.jsx` (NEW v0.2 from P7) with persona row.

---

## Acceptance gates

**v0.2 ship (with P7)**:
- 3 Character Contracts shipped at `vault/.hypha/contracts/{mycelium-professor,skeptic-mushroom,evidence-auditor}.yaml`
- Anti-Ingratiation Filter runs on every lesson body + score output; events.jsonl logs violations
- Minimal 3-dim Persona Coherence Score appears in session jsonl per turn
- Course Trust Panel default tier shows agent name + role version + coherence score
- Smoke test: 5 lesson bodies generated, ≥4 have coherence score ≥ 70 (rough sanity bar)

**v0.4 ship**:
- Role Drift Detector T4 LLM-as-tagger implemented; smoke test on a manufactured 30-turn drift trajectory catches drift
- Persona Coherence Ledger YAML written per session
- Full 8-dim coherence score formula in production
- Functional × Epistemic enforcement: mismatch rejects output

**v0.5+ ship**:
- Agent Registry at `vault/.hypha/agents.yaml`
- Drift Recovery Protocol 7-step runs end-to-end on injected drift
- Training Shard Map visible in expert tier
- Cross-model audit: 1 Character Contract verified to produce equivalent persona across GLM-5.1 / DeepSeek-V4-Pro / Kimi-K2.6 (manual A/B sanity)

---

## Out of scope

- Full Mycelium pet visual design (Companion v0.8, separate spec at `specs/companion-myco.md`)
- HYPHA Constitution document for cross-product persona governance (v2.x)
- Long-term tracking of agent's effect on user's cognitive habits (research-grade, post-v3.0)
- Auto-discovery of NEW drift modes via clustering (v3.0+)

---

## References

- Source theory: `C:\Users\32043\Desktop\HYPHA_Persona_Coherence_Trustable_Agent_Layer.md` (884 lines)
- Sister spec: `specs/anti-slop-layer.md` (P7 — output + reasoning layer)
- Main blueprint integration: `HYPHA_final_blueprint_and_evolution_roadmap.md` §25 (AMD-MEOW-P8)
- Personas register (current state): `app/lib/personas.js`
- Constitution: `app/lib/hypha-constitution.js`
- Companion spec (cross-ref): `specs/companion-myco.md`
