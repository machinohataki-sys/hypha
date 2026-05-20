# Product Blueprint (W3.2)

> Canonical spec for the 10-section product blueprint document, the `blueprint-template.js` lib that round-trips it, and the `screen-product-blueprint.jsx` editor that mounts on top. Source of truth = this file + the lib's exported constants (`SECTIONS`, `RISK_CATEGORIES`, `SEVERITY_LEVELS`, `BLUEPRINT_TEMPLATE`). The lib's behaviour wins on disagreement; this file documents intent.

## Position in the Creation System (BLUEPRINT §11)

W3.2 is the **structured spec layer** of the Creation System. It sits between:

- **W3.1 Creation Pool** — owns the on-disk layout (`vault/<slug>/product/`), the per-product ledger, and the `getProduct(slug)` / `bindProduct(slug)` calls. W3.2 reads / writes the `blueprint.md` file inside that layout but never owns the layout itself.
- **W3.3 Product Transfer** — calls `parseBlueprint()` to extract structured sections so it can score lesson-knowledge-point relevance against `northStar / modules / openQuestions / riskMap`.
- **W3.4 Product Spark** — `linkSparkToBlueprint(slug, sparkId, 'inspirationPool')` appends a row to `product/inspiration-pool.jsonl`; W3.2's render path consumes that jsonl and emits the §7 Inspiration Pool body.

W3.2 is pure UI + parser. It never invokes an LLM. Every change is a local-disk write.

## File format on disk

`vault/<slug>/product/blueprint.md` — markdown with a YAML frontmatter head:

```
---
slug: my-product
name: My Product
product_type: book | tool | course | …
schema_version: 1
created_at: 2026-05-13T10:00:00Z
updated_at: 2026-05-13T10:30:00Z
---

# Product Blueprint

## 1. Product North Star
> 这个产品最终要改变什么？一句话写下它存在的理由。

<body markdown>

## 2. Target Users
…
```

The frontmatter is a hand-rolled minimal YAML scalar map — `schema_version` / `slug` / `name` / `product_type` / `created_at` / `updated_at`. No nested objects, no inline arrays. Quoted via `JSON.stringify` when the value contains YAML-special characters.

Section heading match in `parseBlueprint` is permissive: `## <N>. <text>` is accepted on the number alone, with a case-insensitive heading-text fallback. The `> <hint>` quote line under each heading is stripped on parse so the editor sees only the body. Render output is canonical: number-prefixed heading + the SECTIONS hint as a quote line + body + blank line.

## Section schema (10, order load-bearing)

| # | key             | heading            | Purpose |
|---|-----------------|--------------------|---------|
| 1 | `northStar`     | Product North Star | 一句话存在理由。**Hard-required.** |
| 2 | `targetUsers`   | Target Users       | 1-3 个具体的人，非人口统计。 |
| 3 | `corePain`      | Core Pain          | 用户当前正在承受的代价，不是 "需求"。 |
| 4 | `hypothesis`    | Current Hypothesis | 当前最重要的产品假设，证伪即 pivot。**Hard-required.** |
| 5 | `modules`       | Modules            | 已有模块 + 职责分配，非组件树。 |
| 6 | `openQuestions` | Open Questions     | 3-7 个真正没想清楚的问题。 |
| 7 | `inspirationPool` | Inspiration Pool | 灵感引用 — `[[lesson:slug]]` / `[[note:rel]]` / `[[spark:id]]` / URL。W3.4 spark 通过 inspiration-pool.jsonl 注入。 |
| 8 | `decisionLog`   | Decision Log       | 关键决策记录，引用 `DL-001` 等编号。 |
| 9 | `riskMap`       | Risk Map           | 5 类风险 × 4 级 severity + mitigation。子结构见下。 |
| 10| `roadmap`       | Roadmap            | 从此刻到理想的路径 — 里程碑 + why，非甘特图。 |

10 个 section 顺序就是阅读顺序 — 不可重排。新增 section 是 blueprint-level 决定，要记入 §8 Decision Log（不是单方面加 SECTIONS）。

## Risk Map 子结构 (§9)

Risk Map 的 body 默认作为 opaque markdown 处理，但 lib 提供 `parseRiskMap(body)` / `renderRiskMap(risks)` 把它转 / 还原成结构化记录。

5 个 category（顺序 load-bearing）:

`RISK_CATEGORIES = ['technical', 'business', 'product', 'legal', 'cost']`

4 级 severity:

`SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical']`

每条 risk 的 shape:

```
{ category, description, severity, mitigation }
```

canonical markdown render:

```
### Technical
- **[high]** TLS handshake 拒掉 30% 客户端
  - _mitigation:_ 切回 ALPN h1 fallback，PR-142 已 lock
- **[medium]** Worker pool 在 CJK 输入下偶发死锁
### Business
…
```

未填的 category 渲染为 `### <Category>` + `_(尚未写下。)_` 占位行。`parseRiskMap` 容忍手写偏差 — 找不到 severity 时回退 `medium`，找不到 category 时归入 `product`。

## validateBlueprint 规则

签名: `validateBlueprint(input) → { valid, missing_sections[], warnings[] }`。Input 可为 markdown 串、`parseBlueprint` 返回的对象、或一个 `{ key: body }` map。

1. **Placeholder-only 视为 missing**：以 `_(尚未写下。)_` 开头的 section body 等同未填。
2. **显式 skip**: body 形如 `[skipped: <reason>]` 的算 explicit skip，不计入 `missing_sections` —— 但 hard-required section（`northStar` + `hypothesis`）不可被 skip，违反时 missing + 一条 warning。
3. **Risk Map 软警告**: body 不含任何 `### Category` 子标题时 → warning。
4. **Decision Log 软警告**: 同一 `DL-<n>` 编号重复出现 → warning。
5. **Inspiration Pool 软警告**: 无 `[[…]]` wikilink 也无 URL → warning。
6. `valid = (missing_sections.length === 0)`。warnings 不阻塞 valid。

## 编辑 UI 行为（`screen-product-blueprint.jsx`）

- 入口: app.jsx 右下角浮动按钮 "产品蓝图 · Blueprint" → `setRoute('product-blueprint')`，根据 `goal.slug` / `goal.noteRel` 解析 slug。
- 渲染: 10 个 section 各为可折叠 textarea，左侧渲染 SECTIONS[i].hint 作淡引用行，右侧实时显示 `validateBlueprint` 结果（missing 红、warnings 灰）。
- 自动保存: 30s debounce — useEffect 监听 sections 变化，定时器到点调 `creation:updateBlueprint`（IPC，主端调 `renderBlueprint` + 写盘）。手动 Cmd+S 立即触发同一路径。
- Risk Map: 默认渲染为 markdown textarea；可选展开为 5×4 结构化网格视图（由 lib 的 `parseRiskMap` / `renderRiskMap` 驱动，body 仍 markdown 为准）。
- Inspiration Pool: 显示 §7 body + 从 `inspiration-pool.jsonl` 读出的 spark 引用列表（W3.4 写入），用户可点击进入对应 spark 详情。

## 与 Track A "课程即产品" 闭环

每个 lesson 的 Anti-Slop Confession Layer 输出 `本节最弱处 ___`；该弱处若被 W3.3 Transfer 评分到 `P ≥ 0.6`，会触发 transfer prompt 建议 user 写进对应 blueprint section（dominant section 由 `computeRelevance` 给出）。用户点 "确认迁移" 走 W3.4 创建 spark；spark 经过 `seed → considered → accepted → implemented` 后通过 `linkSparkToBlueprint` 写进 Inspiration Pool。

## 导出表面（authoritative）

`module.exports`:

- `BLUEPRINT_TEMPLATE` — 冻结的 schema 描述
- `SECTIONS` — 10 项有序数组
- `RISK_CATEGORIES`, `SEVERITY_LEVELS` — risk 子结构常量
- `renderBlueprint(productData)` → markdown 串
- `parseBlueprint(markdown)` → `{ frontmatter, sections }`
- `validateBlueprint(input)` → `{ valid, missing_sections, warnings }`
- `renderRiskMap(risks[])`, `parseRiskMap(body)` — 可选的 §9 结构化辅助
- `emptySections()` — UI useState 初始化用的空 map

IPC channels (main.js):

- `creation:getBlueprint` → 读盘 + parseBlueprint
- `creation:updateBlueprint` → renderBlueprint + 写盘 + 触发 `events.jsonl` 一条 row
- `creation:validateBlueprint` → 透明转发 validateBlueprint，不写盘
