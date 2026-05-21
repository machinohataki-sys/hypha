# Web Note Engine — Spec (W5.2)

> BLUEPRINT §10.1 / ROADMAP v1.2 / Wave 5.2 theory-ship.

The Web Note Engine is Hypha's **shrödinger entropy-reduction layer**: every
note, every concept, every spark lives as a typed node on a hidden graph; LLM
calls never traverse the full graph — they receive a budget-bounded Context
Packet. Periodic entropy reduction sweeps dedupe, degrade unused edges, and
distill kernel summaries so the graph compresses over time rather than bloats.

---

## 1. Six layers (`NODE_LAYERS`)

| # | Layer | Definition | Source |
|---|---|---|---|
| 1 | `raw` | A free-form thought as the user dropped it. Default for any new capture. | user / lesson-note import |
| 2 | `atomic` | Single-thesis "atomic card" extracted from a raw. ≥1 atomic per raw. | T4_JUDGE split |
| 3 | `concept` | A reusable cross-card concept distilled when ≥2 atomics share a thesis. | concept-naming |
| 4 | `spark` | A speculative novel claim — a hypothesis to test or pursue. | spark detection |
| 5 | `product_spark` | A spark bound to a specific Product (W3.4 sparks/*.md). | W3.4 createSpark |
| 6 | `kernel` | A distilled summary stitched from multiple nodes; the highest compression. | T6_STRONG distill |

Each layer is **strictly higher than the one below** in semantic specificity.
Promotion is monotonic: you never demote layers, only merge or mark dead.

---

## 2. Thirteen typed edges (`EDGE_TYPES`)

| Edge | Direction | Semantics |
|---|---|---|
| `prerequisite` | A → B | A must be understood before B |
| `explains` | A → B | A is an explanation of B |
| `example_of` | A → B | A is a concrete example of B |
| `contradicts` | A → B | A is in tension with B (conflict marker) |
| `extends` | A → B | A builds on / generalises B |
| `applies_to` | A → B | A is applied to the situation B describes |
| `analogizes` | A → B | A is structurally analogous to B |
| `compresses` | A → B | B is the compressed form of A |
| `operationalizes` | A → B | A turns B into something actionable |
| `sparks` | A → B | A is the seed from which spark B grew |
| `productizes` | A → B | A is productized as B (typically → product_spark) |
| `risks` | A → B | A is a risk to B |
| `decides` | A → B | A is a decision affecting B |

---

## 3. Schemas

### `NODE_SCHEMA`

```text
{
  id:             string  (required, unique within slug, [A-Za-z0-9_-]+)
  layer:          enum    (NODE_LAYERS)
  slug:           string  (curriculum slug)
  content:        string  (body text — may be empty for placeholder raw nodes)
  frontmatter:    object  (free-form, default {})
  edges_from:     string[] (edge ids where this node is from_id)
  edges_to:       string[] (edge ids where this node is to_id)
  utility_score:  number 0..1 (default 0.5)
  last_used:      unix ms timestamp
  created_at:     unix ms timestamp
}
```

### `EDGE_SCHEMA`

```text
{
  _id:           string (assigned at addEdge time)
  from_id:       string (node id)
  to_id:         string (node id, ≠ from_id)
  type:          enum   (EDGE_TYPES)
  strength:      number 0..1 (default 0.5)
  utility_score: number 0..1 (default 0.5)
  last_used:     unix ms timestamp
  token_cost:    number ≥0 (estimate)
  status:        enum   ('active' | 'dormant' | 'broken')
  created_at:    unix ms timestamp
}
```

### `KERNEL_SCHEMA`

```text
{
  id:              string  (required)
  summary:         string  (distilled text)
  source_node_ids: string[] (≥1)
  token_count:     number ≥0
  version:         integer ≥1 (bumps on re-distill)
  created_at:      unix ms timestamp
}
```

---

## 4. Layer promotion triggers + LLM tier

| Transition | Trigger | LLM tier | Edge written |
|---|---|---|---|
| raw → atomic | user finish-ritual OR explicit | T4_JUDGE (split into theses) | `explains` raw → each atomic |
| atomic → concept | ≥2 atomics share a thesis name | T3_MID (concept-name synthesis) | `compresses` each atomic → concept |
| concept/atomic → spark | user marks "灵感" OR companion proposes | (no LLM required — user-supplied hypothesis) | `sparks` source → spark |
| spark → product_spark | spark accepted into a Product | W3.4 createSpark (no LLM) | `productizes` spark → product_spark |
| N nodes → kernel | ≥1 atomic/concept/spark targeted | T6_STRONG distill | `compresses` each source → kernel node |

All LLM calls go through a single hook: `global.__hyphaWebNoteLLM = async ({ tier, prompt }) => string|null`. When unset, the engine falls back to deterministic stubs (split paragraphs, stitched first-sentences) — every promotion remains testable offline.

---

## 5. Context Packet algorithm

`buildContextPacket(slug, queryNodeId, budgetTokens=2000, opts)` produces a budget-bounded substring of the graph centered on `queryNodeId`.

Steps:

1. **Walk** from `queryNodeId` with `maxDepth=2` over `DEFAULT_PACKET_EDGE_TYPES` (`explains`, `prerequisite`, `extends`, `compresses`, `operationalizes`, `example_of`). Only `status='active'` edges are followed.
2. **Score** each visited node:
   `score = max(incident_edge.strength × incident_edge.utility_score) × node.utility_score × 0.7^depth`
3. **Pack** by W5.1 `cheap-router.packContext(items, { budgetTokens })` if available; otherwise fall back to the local packer which greedily takes highest-score nodes until budget exhausts.
4. **Bump utility** on every node that made it into the packet: `last_used = now`, `utility_score += 0.02` (capped at 1).
5. Return `{ ok, packetText, usedNodes, dropped, tokensUsed }`.

The W5.1 integration boundary is feature-detected; the engine stays operational whether W5.1 has shipped or not.

---

## 6. Entropy Reduction Cycle

`runEntropyReductionCycle(slug, opts)` runs six sub-functions in sequence:

| Sub-function | Effect |
|---|---|
| `dedupeNodes` | Identical-content nodes in the same layer merged into one (keeps higher-utility id). |
| `mergeRedundant` | Jaccard token similarity ≥ `redundantThreshold` (default 0.85) within same layer → merge. |
| `degradeUnused` | Edges with `last_used > thresholdDays` (default 30) flipped to `status='dormant'`. |
| `promoteHighUtility` | Nodes with `utility_score ≥ utilityCutoff` (default 0.85) get all outgoing edges bumped `+0.05` strength. |
| `detectConflicts` | All active `contradicts` edges emitted as `conflict_detected` events. |
| `markDeadNodes` | Nodes with 0 active edges and `utility_score ≤ utilityFloor` (default 0.2) marked + emit `dead_node_detected`. |

`runEntropyReductionCycle` is **always async, always non-throwing** — the report payload surfaces any sub-function failure but never aborts the cycle. The engine event bus (`engine.onEntropyEvent('dead_node_detected', handler)`) lets W5.3 Living Note Reactivation subscribe directly to dead-node signals without polling.

---

## 7. File layout

Hidden under each curriculum slug so it never pollutes user-facing lesson notes:

```
vault/<slug>/.web-graph/
  nodes/<node-id>.json     ← one JSON per node (NODE_SCHEMA)
  edges.jsonl              ← append-only log with tombstone rows
  kernels/<kernel-id>.json ← KERNEL_SCHEMA
```

`edges.jsonl` is append-only for crash safety. `_readAllEdges` replays the log keeping the latest row per `_id`; tombstone rows (`{ tombstone: true, id }`) clear an id. `updateEdge` writes both a tombstone and a fresh row in one append. `mergeNodes` writes a tombstone + a new row under a **fresh** edge `_id` so the original tombstone does not mask the re-pointed edge.

---

## 8. Boundary with W5.1 Cheap Router

`context-packet.js::_tryW51` feature-detects `app/lib/llm/cheap-router.js` and uses `packContext(items, opts)` if exported. Until W5.1 surfaces that function, the local greedy packer is used — same return shape, slightly worse packing quality. The Context Packet contract is locked here in W5.2 so W5.1 can wire in later without breaking callers.

## 9. Boundary with W5.3 Living Note Reactivation

`entropy-reduction.js` emits `dead_node_detected` events through the engine's tiny synchronous event bus. W5.3's `livingnote:detectDead` IPC can either (a) call `runEntropyReductionCycle` directly and inspect `report.dead`, or (b) subscribe to the event bus via `engine.onEntropyEvent('dead_node_detected', handler)` for streaming updates. W5.2 does not delete nodes — it only marks `frontmatter.dead_marked_at`. W5.3 owns the actual archive / resurrection decision.

## 10. Boundary with W3.4 Product Spark

`layer-promotion.js::promoteToProductSpark` is the bridge. It tries to call `productSpark.createSpark(productSlug, { seed_text, source })`; success records the W3.4 spark id into the local `product_spark` node frontmatter (`w34_spark_id`). If W3.4 is unavailable, the local mirror still completes — file-as-substrate means the graph is canonical; W3.4 is the product-side index.

## 11. Boundary with existing atlas (`lesson-note.js`)

`depositLessonNote` writes a `lesson-<idx>.md` to the slug. The Web Note Engine surface lets a future caller wrap that deposit with `engine.addNode({ layer: 'raw', content: noteBody, frontmatter: { lesson_idx, source: 'lesson-note' } })` so the lesson concept tracker becomes one source of `raw` nodes among many. This wire-up is **not** done in W5.2 v1 (deferred to a v1.1 patch); the engine is ready when the caller arrives.

---

## 12. IPC + preload surface

Main: `webnote:addNode|addEdge|getNode|listNodes|getEdges|walk|merge|promote|distillKernel|contextPacket|entropyReduction`.

Renderer: `window.ptor.webnote.{ addNode, addEdge, getNode, listNodes, getEdges, walk, merge, promote, distillKernel, contextPacket, entropyReduction }`.

`promote(slug, direction, args)` switches on `direction ∈ { raw_to_atomic | atomic_to_concept | to_spark | to_product_spark }`. `distillKernel` is its own verb because it consumes a heterogeneous node-id list.

## 13. UI surface

`NotebookScreen` (`app/design/screen-notebook.jsx`) gains a "网状视图" toggle next to the existing "切换地图" button. When opened, the screen lists nodes-per-layer with counts; the full SVG/canvas spider-web render is deferred to v1.3+. The toggle is gated on `slug` being present and on `window.ptor.webnote` being exposed — degrades silently otherwise.

---

## 14. Out of scope (v1.0)

- True SVG/canvas spider-web render (placeholder counts only).
- LLM-grounded atomic split (deterministic paragraph split fallback).
- BGE-M3 cosine merge in `mergeRedundant` (Jaccard fallback).
- Cross-slug edges (every node is slug-scoped).
- W5.3 / W5.1 deep integration beyond the documented event + feature-detect boundaries.
- Per-edge replay log compaction (the engine accepts an O(N) log scan on `_readAllEdges`; v1.1 may add a snapshot file).
