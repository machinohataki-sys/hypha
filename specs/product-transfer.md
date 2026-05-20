# Product Transfer Trigger (W3.3)

> Canonical spec for the optional "迁移到你的产品" callout that fires at the end of a Lesson / Deepen / Note when the just-learned knowledge point is relevant enough to the user's product blueprint. Source of truth = this file + `app/lib/product-transfer.js` exports.

## Position in the Creation System (BLUEPRINT §11.3)

W3.3 is the **gate** between Lesson System (W2) and Creation System (W3). It does not write to the product pool; it only:

1. Reads the lesson body off disk (`vault/<slug>/lesson-N.body.json`).
2. Reads the product blueprint via `W3.1 creation-pool.getProduct(slug)` (which internally uses `W3.2 parseBlueprint`).
3. Decides whether the KP warrants emitting the 10th-segment transfer callout in the lesson body.
4. If yes — synthesizes the callout markdown.
5. Persists an `events.jsonl` row + returns the structured decision.

The downstream "确认迁移" button in the UI calls `W3.4 spark.create()` — W3.3 itself never creates a spark.

## Core principle (blueprint §11.3)

> 不强迁移; 只在相关性足够高时触发。

The default is **silent**. Cheap-stage tokenization gates every lesson, but the callout never renders unless `P ≥ THRESHOLD_DEFAULT (0.6)`. The lesson body shape is identical with and without the callout — it's an optional segment, not a required field.

## Relevance score P

`computeRelevance({ lessonKP, productBlueprint, lessonContext }) → { P, evidence[], suggested_section }`

Two-stage:

### Cheap stage (always runs, zero LLM)

1. **Tokenize** the KP — concat `title + canonical_example + thesis + definition + learnGoal + lessonTitle`, lowercase, split on whitespace + punctuation. Custom CJK + ASCII tokenizer (`_tokenize`) keeps each CJK char as a single token, drops ASCII tokens < 2 chars, scrubs a tiny stopword list (`the / and / for / 的 / 是 / 和 …`).
2. **Tokenize** each blueprint section in the `SECTION_ENUM` (`northStar / modules / openQuestions / riskMap / assumptionLedger / killCriteria / general`).
3. **Jaccard overlap** per section: `inter / union`. Pick the dominant section + the second-best.
4. **Aggregate**: `P_cheap = min(1, top + 0.5 × second)` — rewards a KP that lights up multiple sections rather than one.
5. **Product-name boost**: if the blueprint's `product_name` substring matches the KP haystack, `P_cheap += 0.15` (capped at 1).
6. `suggested_section` = the dominant section by Jaccard.

### LLM refinement stage (T4_JUDGE)

Currently **mocked** (per task brief: "T4_JUDGE LLM 调用全 mock"). `_mockLLMRefine` returns `P_cheap` unchanged + a `llm_stage=mock` evidence tag. The surface contract `{ P_refined, suggested_section, evidence_added }` is stable — real wiring lands with the W1.3.1 calibration wave when prompt template + golden set lock. Monotone bound: `|P_llm − P_cheap| ≤ 0.30` (the lib defines `LLM_REFINEMENT_BOUND` for the constraint).

## Gate decision

`shouldTriggerTransfer(P, { threshold } = {}) → bool`

- Default `threshold = THRESHOLD_DEFAULT = 0.6`.
- Non-finite or NaN P → `false`.

## generateTransferPrompt — mandatory structure

`generateTransferPrompt({ lessonKP, productBlueprint, P, suggested_section }) → { content, structure, mocked }`

Output markdown body MUST contain, in order:

1. **Heading**: `## 迁移到你的产品 / 作品`
2. **Opening insight line** (1 sentence, ≤40 字):
   `<kpName> 对 <productName> 的启发是: <insight>`
3. **3-item numbered actionable list**: each line `<verb> X` — verb restricted to `删 / 添加 / 改 / 砍 / 守 / 验` (减法优先, 加法需 justification).
4. **Closing risk line** (1 sentence): `但可能误用为 ___`

This 1 + 3 + 1 shape is load-bearing — the W1.3 Anti-Illusion drill assumes it, the W3.4 spark.core_transfer extraction relies on the opening sentence, and the lesson body schema reserves exactly one such block per lesson.

Forbidden in the content: training-data terminology (AI / LLM / embedding / prompt / RAG / vector / model / fine-tune), emoji, Chinese AI-流量词 (`这一刀 / 闭环 / 拉满 / 王炸 / 干货 / 直击灵魂 / 上分 / 上车`).

## triggerTransfer — main entry

`async triggerTransfer(slug, lessonIdx, kpId, opts) → { fired, P, content, suggested_section, evidence, structure, _meta }`

1. Validate `slug + lessonIdx` (else `bad_input` no-op).
2. Load lesson body via `vault.readJSON('<slug>/lesson-N.body.json')`. Extracts `body.knowledge_points[i]` if `kpId` given, else falls back to body-level `{ thesis, canonical_example, mechanism_explanation }`.
3. Load blueprint via `creation-pool.getProduct(slug)`. **If no product bound → silent skip, no events.jsonl row** (the steady state in v0.x; would flood log otherwise).
4. `computeRelevance` → `shouldTriggerTransfer` → conditional `generateTransferPrompt`.
5. Append `events.jsonl` row regardless of fire (above the no-blueprint floor):

```json
{
  "ts": "2026-05-13T11:00:00Z",
  "op": "transfer:fired",
  "topic": "<slug>",
  "idx": <lessonIdx>,
  "kp_id": "<kpId or lessonKP.id>",
  "P": 0.73,
  "suggested_section": "modules",
  "fired": true
}
```

6. Return decision payload. The caller (main.js) is responsible for writing the returned content back into the lesson body JSON — keeping disk I/O in one owner.

## Boundary contracts

- **W3.1 Creation Pool** — `getProduct(slug)` supplies the normalized `{ product_name, sections: {…} }` shape. W3.3 reads only; never writes.
- **W3.2 Blueprint template** — section keys in W3.3's `SECTION_ENUM` are a strict subset of W3.2 section keys (`northStar / modules / openQuestions / riskMap`) plus two not-yet-shipped slots (`assumptionLedger / killCriteria`) and a `general` fallback. When W3.2 ships those last two, no W3.3 change needed.
- **W3.4 Product Spark** — the UI button "确认迁移到 spark" calls `window.ptor.spark.create(slug, sparkData)` with:

```js
{
  source: { type: 'lesson', ref: `${slug}/lesson-${lessonIdx}#${kpId}` },
  core_transfer: structure.opening,             // the 1-sentence insight
  possible_actions: structure.impacts,          // the 3 verbs
  risk: structure.risk,                         // the "但可能误用为 ___" tail
  related_product: productBlueprint.product_name,
  affected_modules: suggested_section === 'modules' ? [...] : [],
}
```

The spark lands in `vault/<slug>/product/sparks/`. W3.3 itself never touches that directory.

- **W1.3 Anti-Illusion** — when the `no_creation_reflow` illusion gate fires (user has been learning for N lessons without a single transfer / spark), the drill prompt can seed itself with `generateTransferPrompt()` output. The drill copy is then: "你已 X 节课没有把 lesson 迁回产品 — 这一段建议你做的事是 ___". W3.3 exposes the prompt generator publicly so this drill can re-use it.

## Cost model

- Cheap stage: O(n) over normalized token sets, no LLM, always runs.
- LLM stage: 1 × T4_JUDGE refine (mocked today). Real wiring will add 1 call per lesson-end if `P_cheap > 0.4` (cheap-stage floor below LLM-refinement budget).
- Prompt synthesis: 1 × T4_JUDGE structured markdown (mocked today).

When T4_JUDGE wires, the budget per lesson is bounded at 2 LLM calls + ~600 input tokens (KP + 4 section excerpts) + ~400 output tokens (refined P + prompt body).

## Exports

```
computeRelevance / shouldTriggerTransfer / generateTransferPrompt / triggerTransfer
_tokenize / _jaccard                         // exposed for tests + future T4_JUDGE wiring
SECTION_ENUM / THRESHOLD_DEFAULT / LLM_REFINEMENT_BOUND
```

IPC channels (main.js):

- `transfer:compute` → wraps `computeRelevance` (read-only, returns P + evidence + suggested_section).
- `transfer:trigger` → wraps `triggerTransfer` (writes events.jsonl, returns content for the caller to write into the lesson body).
