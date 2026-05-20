# Cheap Intelligence Router — W5.1

> Theory-shipped 2026-05-13 per BLUEPRINT §17.2 + ROADMAP v1.1.
> Source files: `app/lib/llm/cheap-router.js` + `embed-stub.js` + `local-stub.js` + `context-packer.js`.

## Why this exists

Hypha has roughly six task classes whose accuracy is fine at cheap-tier
intelligence, where "cheap" means rule-based, embedding-based, or local-model.
Burning T6_STRONG cloud LLM calls (GLM-5.1 / DeepSeek-V4-Pro / Kimi-K2.6) on
note routing or pack first-pass is both expensive and slow. The Cheap Router
serves these tasks from the floor of the cost curve and only escalates when
the cheap pass returns an ambiguous verdict.

## Capability tiers

| Tier      | Realization                          | Cost (relative)       | Use cases                                              |
|-----------|--------------------------------------|-----------------------|--------------------------------------------------------|
| T0_RULE   | Pure JS (regex / Jaccard / lookup)   | ~ 0 (CPU only)        | keyword sieves, file-size guards, event-type templates |
| T1_EMBED  | BGE-M3 cosine similarity             | ~ 0 (local) / cents   | semantic note routing, related-note retrieval          |
| T2_LOCAL  | Gemma 3 4B via Ollama                | ~ 0 (local)           | Companion state refinement, simple classification      |
| T3_MID    | GLM-4.5-Air / DeepSeek-Flash         | low cloud spend       | Pack 二判, Drift 二审, transfer expansion              |
| T4_JUDGE  | GLM-4.5-Air / DeepSeek-Flash / Kimi  | low cloud spend       | Quality Harness micro judges                           |
| T6_STRONG | GLM-5.1 / DeepSeek-V4-Pro / Kimi-K2.6| high cloud spend      | Lesson plan, body, complex reasoning                   |

T0 / T1 / T2 are owned by W5.1 (this stream). T3 / T4 / T6 are owned by the
capability-class router (`router.js`) shipped in Phase D 2026-05-08.

## Task → tier mapping

| Task                    | Default tier | Escalation tier | Trigger                                                       |
|-------------------------|--------------|-----------------|---------------------------------------------------------------|
| relevance_score         | T0_RULE      | T1_EMBED        | Jaccard ∈ [0.4, 0.7] fuzzy band                               |
| pack_first_pass         | T0_RULE      | T3_MID          | mid-size file with < 2 title keyword hits                     |
| note_routing            | T1_EMBED     | T3_MID          | top candidate score ≤ 0.55 OR gap to runner-up < 0.1          |
| quality_score           | T0_RULE      | T3_MID          | heuristic score ∈ [0.4, 0.7]                                  |
| transfer_first_pass     | T0_RULE      | T3_MID          | any transfer signal keyword hit                               |
| companion_state         | T0_RULE      | T2_LOCAL        | caller passes `{ refine: true }`                              |

Unknown task types resolve to T3_MID with `needs_escalation: true` so callers
can register new tasks ahead of router updates without crashing.

## Fuzzy-band rule

`relevance_score` is the canonical fuzzy-band case. The T0 Jaccard score
buckets into three regions:

```
[0.0, 0.4)    confident: doc is not relevant — stay on T0
[0.4, 0.7]    ambiguous: tokens overlap somewhat but content meaning unclear
              → escalate to T1_EMBED (BGE-M3 cosine), use that as final score
(0.7, 1.0]    confident: doc is relevant — stay on T0
```

The fuzzy thresholds (`FUZZY_RELEVANCE_LO`, `FUZZY_RELEVANCE_HI`) are exported
from `cheap-router.js` so the router test grid can pin them.

## Context Packer token budget

`packContext({ task, candidates, budgetTokens, query })` runs:

1. Normalize candidates to `{id, text}` objects (drop empty text).
2. Rank by `cheapRouter.runCheapTask('relevance_score')` against the query.
3. Greedy fill: iterate ranked candidates; include if it fits remaining
   budget (with `SAFETY_MARGIN = 0.95`); skip if too large but keep trying
   smaller ones.
4. Return `{ packedText, usedCandidates, droppedCount, tokenEstimate,
   budgetTokens, ranking }`.

### Token estimator

`estimateTokens(text)` uses a script-aware rule of thumb:

- CJK code units cost ~ 0.5 token each (≈ 2 chars / token).
- Latin runs cost ~ 0.25 token per char (≈ 4 chars / token).

This is intentionally NOT a real tokenizer — we keep the cheap router free
of `tiktoken`/`@dqbd/tiktoken` deps. Within ±15% of cl100k_base on mixed
CN/EN in informal benchmarking; acceptable for budget arithmetic since the
strong-model side re-tokenizes anyway and we leave a 5% safety margin.

## BGE-M3 real-embedder path (TODO until v0.8)

`embed-stub.js::_tryRealEmbedder` currently returns null and falls through to
the mock. Two real paths are designed:

- **Path A (Ollama, preferred)**: probe `GET http://localhost:11434/api/tags`,
  check `bge-m3` model present. If yes, `POST /api/embeddings` with
  `{ model:'bge-m3', prompt:text }` returns `{ embedding: float[1024] }`.
  Preferred because the same Ollama runtime already serves T2_LOCAL Gemma.
- **Path B (transformers.js, fallback)**: `require('@xenova/transformers')`,
  call `pipeline('feature-extraction', 'Xenova/bge-m3', {quantized:true})`.
  ONNX model is ~ 600MB on first run.

The mock fallback is a deterministic character-bigram hash producing a
1024-d L2-normalized vector. Same input → identical vector (test invariant).
Cosine similarity of related strings stays positive; `topKSimilar` ranks
plausibly. This keeps W5.2 / W5.3 integration unblocked while real BGE-M3
infra is built out.

## Gemma 3 4B Ollama path (live, with fallback)

`local-stub.js::runLocal` is wired against the real Ollama HTTP API at
`http://localhost:11434/api/generate`. On a clean machine where Ollama is
unreachable, `isOllamaAvailable()` returns `false` (5-min cached so we don't
hammer the loopback), and `runLocal` falls back to template-based responses
keyed by Companion trigger type (`spark_sprout`, `finish_ritual`,
`goal_drift`, `silence_too_long`, `misconception`, `evidence_required`).
The fallback templates honor the manuscript register (no `AI` / `model` /
emoji, per `hypha-constitution.js` FORBIDDEN list).

## Integration with the capability-class router

W5.1 does NOT replace `router.js::executeChat` — it sits in front of it as
an opt-in hook. Callers that pass `chatArgs.prefer_cheap = true` plus a
`cheap_task` + `cheap_input` payload get a chance for the request to be
served by the cheap pipeline. If the cheap pass returns
`needs_escalation: true`, `executeChat` falls through to the normal
DispatchPolicy weighted random pick across GLM/DeepSeek/Kimi. Default OFF —
no existing caller changes behavior.

## Integration with W5.2 Web Note Engine

The Web Note Engine needs typed-edge resolution for `[[wikilink]]` targets.
W5.2 should call `cheap-router.runCheapTask('note_routing', { query, candidates })`
to resolve `target → vault-entity`. The T1_EMBED default is the right
primitive for cross-lingual / abbreviation-tolerant matching; T3_MID
escalation handles ambiguous wikilinks that need a structured judge.

## Integration with W5.3 Living Note Reactivation

Reactivation triggers (the user opens a note related to a current Lesson
concept) need similarity scoring between the active concept and the note's
crystallized content. W5.3 should call `cheap-router.runCheapTask('relevance_score', { query: concept, doc: note_summary })`. The T0 Jaccard fast path handles the
~ 90% obvious matches; the T1 embed escalation handles cross-language and
paraphrase cases.

## Test surface

`__tests__/cheap-router.test.js` ships ≥ 14 `test.todo` placeholders pinning
the contract. Real assertions land when Jest is wired or when a Node
runner is configured for `app/lib/llm/`.

## What is NOT in W5.1

- Real BGE-M3 wiring (intentional-placeholder for v0.8 Companion).
- Cost ledger integration (will plug `cheap_rationale` field into the ledger
  during W5.4 unification).
- Per-task budget overrides (currently global `DEFAULT_BUDGET_TOKENS = 2000`).
- `app/agent.js` migration to call cheap-router for harvest filtering
  (deferred — agent.js still runs on the legacy `providers.js` layer).
