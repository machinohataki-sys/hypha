# Product Spark (W3.4)

> Canonical spec for the product-spark layer — small structured "idea-seedlings" that get harvested from lessons / notes / books / packs and tracked through a 5-state lifecycle. Source of truth = this file + `app/lib/product-spark.js` exports.

## Position in the Creation System (BLUEPRINT §11.4)

W3.4 is the **bridge between learning and building**. Each spark is one finite atomic idea — captured from a knowledge point, a marginal note, a book excerpt, or a community pack — that *might* warrant a change to the user's product. The W3.4 lifecycle is how an idea survives the trip from "interesting" to either "shipped" or "consciously rejected", never as silent neglect.

Disk layout (owned by W3.1):

```
vault/<slug>/product/
  blueprint.md                          ← W3.2
  inspiration-pool.jsonl                ← W3.4 appends rows (linkSparkToBlueprint)
  sparks/
    spark-<YYYYMMDDHHmmss>-<hash>.md    ← one file per spark
    _archive/
      spark-<id>.md                     ← archived sparks
```

The `sparks/*.md` file is the **canonical record** for each spark. `events.jsonl` rows + `inspiration-pool.jsonl` rows are redundant indexes — if either gets out of sync, the spark file wins.

## 7-field schema (BLUEPRINT §11.4)

| 字段 | 字段名 | Required at create | Mutable via | 说明 |
|---|---|---|---|---|
| 1 来源 | `source.type` + `source.ref` (+ optional `source.label`) | yes | `updateSpark` (label only via shallow merge) | `type ∈ {'lesson', 'note', 'book', 'pack'}`. `ref` 是 vault-relative 引用，e.g. `slug/lesson-7.md#kp-3` 或 `slug/notes/N42.md`. |
| 2 关联产品 | `related_product` | optional (defaults `''`) | `updateSpark` | 字符串名称, 通常 = product blueprint frontmatter 的 `name`. |
| 3 核心迁移 | `core_transfer` | yes | `updateSpark` | 1-2 句话, 通常源自 W3.3 `generateTransferPrompt` 的 opening insight. seed → considered 转换前不能为空. |
| 4 影响模块 | `affected_modules[]` | optional (defaults `[]`) | `updateSpark` | 字符串数组. 已知模块词表 `AFFECTED_MODULES_KNOWN = ['Lesson', 'Note', 'Commons', 'Library', 'Companion', 'Pricing', 'Security']`, 但用户可自由添加 — 词表只用于 UI autocomplete. |
| 5 可能动作 | `possible_actions[]` | optional (defaults `[]`) | `updateSpark` | 字符串数组. 通常源自 W3.3 prompt 的 3 个 numbered impact 行. |
| 6 风险 | `risk` | optional (defaults `''`) | `updateSpark` | 1 句, 源自 W3.3 prompt 的 "但可能误用为 ___" tail. |
| 7 状态 | `state ∈ {'seed','considered','accepted','rejected','implemented'}` | defaults `'seed'` | **`transitionState` only** — `updateSpark` 拒收 `state` field | 状态机见下. |

Engine-managed fields (immutable to `updateSpark`):

- `spark_id` — `YYYYMMDDHHmmss-<6hex>` UTC compact stamp + SHA-256 prefix.
- `created_at` — ISO timestamp at create.
- `transitions[]` — append-only audit trail; each row `{ from, to, ts, reason }`.

## State machine

```
       ┌───────────┐  consider  ┌──────────────┐  accept   ┌──────────┐  implement  ┌──────────────┐
seed ──┤  reject?  │──────────▶│  considered  │──────────▶│ accepted │────────────▶│ implemented  │ (terminal)
       └────┬──────┘           └──────┬───────┘           └────┬─────┘             └──────────────┘
            │ reject                  │ reject                 │ reject
            ▼                         ▼                        ▼
       ┌─────────┐               ┌─────────┐              ┌─────────┐
       │ rejected│               │ rejected│              │ rejected│ (terminal)
       └─────────┘               └─────────┘              └─────────┘
```

Adjacency table (`TRANSITIONS`):

| from | legal next |
|---|---|
| `seed` | `considered`, `rejected` |
| `considered` | `accepted`, `rejected` |
| `accepted` | `implemented`, `rejected` |
| `rejected` | (terminal — no outbound) |
| `implemented` | (terminal — no outbound) |

`TERMINAL_STATES = ['rejected', 'implemented']`.

### Transition semantics

- `transitionState(slug, sparkId, newState, { reason })` is the only path that mutates `state`. It calls `_assertTransitionLegal(from, to)` first — any illegal jump (e.g. `seed → accepted`, or *any* outbound from a terminal state) throws `SparkStateError` synchronously with `{ from, to, legalNext, terminal }` metadata.
- The transition is appended to `spark.transitions[]` (audit trail) and emits a typed event:

```json
{
  "type": "product:spark:transitioned",
  "spark_id": "<id>",
  "from": "<state>",
  "to":   "<state>",
  "reason": "<user-supplied or empty>",
  "terminal": true | false,
  "companion_hook": "sprout" | null
}
```

The `companion_hook` field is set to `'sprout'` **only** on the `seed → considered` transition. This is the W3.6 Companion 发芽 (sprout) trigger — companion subscribes to `events.jsonl` and watches for `companion_hook === 'sprout'` to fire its 发芽表达 reaction. Until W3.6 ships, the flag is observed by no listener; the spark file itself remains useful standalone.

## Markdown file format

Frontmatter (hand-rolled minimal YAML, matches creation-pool / lesson-note convention):

```
---
spark_id: 20260513110015-a4f1c2
created_at: 2026-05-13T11:00:15Z
state: considered
source_type: lesson
source_ref: my-slug/lesson-7.md#kp-3
related_product: My Product
affected_modules: [Lesson, Companion]
transitions: [{"from":"seed","to":"considered","ts":"2026-05-13T11:05:00Z","reason":"user clicked Consider"}]
---
```

Body (7 section headings, order load-bearing):

```
# Product Spark

## 来源 (Source)
- **type**: lesson
- **ref**: my-slug/lesson-7.md#kp-3
- **label**: <optional human label>

## 关联产品 (Related Product)
My Product

## 核心迁移 (Core Transfer)
<1-2 句, opening insight from W3.3 prompt>

## 影响模块 (Affected Modules)
- Lesson
- Companion

## 可能动作 (Possible Actions)
- 删 Lesson chat 的鼓励语 — 用 stillness 替代
- 添加 Companion 的 doubt-mode 反射

## 风险 (Risk)
<1 句, "但可能误用为 ___">

## 状态记录 (Transitions)
| from | → | to | when | reason |
|---|---|---|---|---|
| seed | → | considered | 2026-05-13T11:05:00Z | user clicked Consider |
```

Body section parsing is **best-effort** — frontmatter is authoritative for `state` / `transitions`, body is hydrated only for `core_transfer / risk / possible_actions / related_product` via regex. Hand-edits to the body round-trip safely; hand-edits to the state-machine fields in frontmatter are accepted as ground truth (no automatic repair).

## Public API (`module.exports`)

```
createSpark(slug, sparkData) → { ok, spark_id, state, path, spark }
listSparks(slug, filterState?) → spark[]                       // newest first
getSpark(slug, sparkId) → spark                                // throws SparkNotFoundError
updateSpark(slug, sparkId, patch) → { ok, spark }              // refuses state / spark_id / created_at / transitions
transitionState(slug, sparkId, newState, opts?) → { ok, spark, transition }
archiveSpark(slug, sparkId) → { ok, archive_path }             // moves to _archive/, versioned if collision
linkSparkToBlueprint(slug, sparkId, section?) → { ok, pool_path, blueprint_section }

STATES / TRANSITIONS / TERMINAL_STATES / SOURCE_TYPES / AFFECTED_MODULES_KNOWN
SparkStateError / SparkValidationError / SparkNotFoundError
```

Errors are exported so callers can `instanceof` narrow:

- `SparkValidationError` (`code: 'SPARK_INPUT_INVALID'`) — bad input shape.
- `SparkStateError` (`code: 'SPARK_STATE_INVALID'`) — illegal transition.
- `SparkNotFoundError` (`code: 'SPARK_NOT_FOUND'`) — spark file missing.

## UI flow (`screen-spark-pool.jsx`)

1. **Entry** — app.jsx floating button "Sparks" (visible when a slug is resolvable, same surfaces as the Blueprint button). Sets route `'spark-pool'` and passes `{ slug, onBack }`.
2. **Top bar** — filter tabs (`All / Seed / Considered / Accepted / Rejected / Implemented`) + back button. Filter change re-calls `spark.list(slug, filter)` on the next effect tick.
3. **Two-column body**:
   - Left list: one card per spark — truncated `core_transfer` (~80 字) + colored state badge + source ref + `created_at` short stamp. Newest first.
   - Right detail: when a card is clicked, full 7-field detail panel + transition history table + the legal transition buttons for the current state.
4. **Transition buttons** (visible only when legal):
   - `seed` → `[Consider]` `[Reject]`
   - `considered` → `[Accept]` `[Reject]`
   - `accepted` → `[Implement]` `[Reject]`
   - `rejected` → (terminal, no buttons; copy "已 reject — 终态" italic faded)
   - `implemented` → (terminal, no buttons; copy "已 implemented — 终态" italic faded)
5. **ESC → onBack**.

千金 register: 暖色 brass-bright + ink-3, italic Garamond 仅 heading, 无 emoji, 无感叹号. State badge 颜色 (灰/黄/绿/红/蓝) 是结构信号, 非装饰.

## Boundary contracts

- **W3.1 Creation Pool** — owns `vault/<slug>/product/sparks/` directory. W3.4 uses `creation-pool-schema.PRODUCT_LAYOUT` for path constants; falls back to literal `'product/sparks'` when the schema module is absent (tests / dry-runs).
- **W3.2 Product Blueprint** — `linkSparkToBlueprint(slug, sparkId, 'inspirationPool')` appends a row to `product/inspiration-pool.jsonl`. When W3.2 re-renders the blueprint, its §7 Inspiration Pool body lists each spark with a `[[spark:<id>]]` wikilink. W3.4 does **not** call into W3.2 directly — the jsonl is the substrate.
- **W3.3 Product Transfer** — the UI button "确认迁移到 spark" in the transfer callout calls `spark.create(slug, { source, core_transfer, possible_actions, risk, related_product, affected_modules })` with the W3.3 prompt structure mapped 1:1.
- **W3.5 / W3.6 Companion** — companion subscribes to `events.jsonl`. `product:spark:created` triggers no expression by default. `product:spark:transitioned` with `companion_hook === 'sprout'` (i.e. `seed → considered`) fires the 发芽 reaction. The hook flag is wired in W3.4 today even though W3.6 listener ships later — schema is forward-compatible.

## Failure handling

- File-system writes are synchronous + atomic-on-success (write → fs.writeFileSync). Partial writes on disk-full surface as a thrown Error from `createSpark` / `updateSpark`; the spark file is the only persistent state, so a failed write means no state change.
- `events.write` failures are caught silently (`/* graceful */`) — the events log is a redundant index, the file is canonical.
- `_archive/` collision (same spark archived twice) preserves history by versioning the filename (`.v2.md`, `.v3.md`, …) instead of overwriting.
