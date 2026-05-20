# Bibliography Grounding — 参考书目地基系统

> **STATUS**: W6.1 scaffold shipped 2026-05-13 (Profile + Synthesis + IPC + UI scaffold).
> 对应 [BLUEPRINT.md §4](../BLUEPRINT.md) "Bibliography Grounding：参考书目地基系统"。
> Roadmap：v1.5 (Alpha) / v1.6 (with Library) — 见 [ROADMAP.md](../ROADMAP.md)。
> 主要代码：`app/lib/grounding/{index,book-profile,synthesis}.js` + `app/main.js`
> `grounding:*` IPC handlers + `app/preload.js` `window.ptor.grounding.*` bridge +
> `app/design/screen-grounding-review.jsx` + `app/design/screen-onboarding.jsx`
> 参考书 picker. 缓存落点 `vault/<slug>/grounding/profiles/<book-id>.json` +
> `vault/<slug>/grounding/synthesis.json`.

---

## 为什么需要

> **参考书不是课后阅读材料，而是课程生成前的地基。**

普通 LLM 生成课程的失败模式：把书名当作主题词调用普通知识，假装"读过"。Bibliography Grounding 强制让 Lesson Generator 在生成路径前**先把书消化成结构化地基**，再让地基约束课程结构。

---

## 流程图

```text
User 在 Onboarding 填 Goal Contract
     │
     ▼
选参考书 (可选, 来自 Library 已上传书目)
     │
     ▼
HYPHA 检查 Commons / Library 已有 Sparks
     │
     ├── 有 Book Spark Pack (W6.2)  → 低 token 调用, fast-path
     └── 无                          → 启动 Longform Distillation (W6.2 并行 stream)
     │
     ▼
buildBookProfile(每本书) — 8 字段结构化抽取 (T4_JUDGE class)
     │
     ▼  (并行)
synthesizeGrounding(多本书) — 6 字段综合 (T6_STRONG class)
     │
     ▼
注入 designSkeletonOnly SYSTEM_PROMPT (GROUNDING PROFILE block 在 LIBRARY_EVIDENCE 之前)
     │
     ▼
生成课程骨架 + 后续 lesson body
```

---

## Book Grounding Profile (§4.1) — 8 字段

每本书进入课程生成前, 转为结构化地基. 字段定义:

| Field                       | Type           | 含义                                                    |
|-----------------------------|----------------|---------------------------------------------------------|
| `book_id`                   | string         | Library 中的 slug 索引                                  |
| `title`                     | string         | 显示标题 (从 library manifest 镜像)                     |
| `fit_to_goal`               | string ≤600    | 这本书能为当前 Goal 提供什么 (1-3 句)                   |
| `goal_relevance`            | string ≤400    | 与用户 Goal 的关系 (1-2 句)                             |
| `core_sparks`               | string[] ≤7    | 可进入课程的核心 Sparks (每条 ≤120 字符)                |
| `unfit_content`             | string[] ≤5    | 不适合当前 Goal 的内容                                  |
| `risks_and_outdated`        | string[] ≤5    | 风险与过时点 (dated claims, 撤回, 意识形态 caveats)     |
| `transferable_methodology`  | string[] ≤5    | 可迁移方法论 (超越本书例子)                             |
| `productizable_inspiration` | string[] ≤5    | 可产品化启发 (喂 Creation System)                       |

附加字段 (内部): `generated_at`, `version`, `_goal_hash`, `_cached`.

每本书 1 个 profile 文件: `vault/<slug>/grounding/profiles/<book-id>.json`.

---

## Grounding Synthesis (§4.2) — 6 字段

多本书不能堆砌, 要合成. HYPHA 判断:
- 每本书负责什么
- 哪些互补
- 哪些冲突
- 哪本主地基
- 哪本辅助
- 哪些内容不进入当前课程

| Field                  | Type                | 含义                                                |
|------------------------|---------------------|-----------------------------------------------------|
| `books_with_roles`     | `[{book_id, role, responsibility}]` | role ∈ `primary` / `secondary` / `supplement`. 恰好 1 本 primary |
| `complementary_pairs`  | `[{book_a, book_b, complement_topic}]` | 互补对                              |
| `conflicts`            | `[{book_a, book_b, conflict_topic, resolution}]` | 冲突 + 课程采纳哪派 |
| `excluded_content`     | `[{book_id, topic}]` | 该书覆盖但本次课程不进入                            |
| `synthesis_notes`      | string ≤700        | 一段总述: 哪本主, 哪本辅, 哪本谨慎用                |
| `_hash`                | string (sha1[:12])  | hash(goalHash + sorted(bookIds)) — 缓存失效判定     |

输出文件: `vault/<slug>/grounding/synthesis.json`.

---

## 缓存策略

- **Profile cache key**: `_goal_hash` = sha1(north_star_goal + learning_model + user_intent + main_creation).
  - Goal 改 → profile 重生 (因 `fit_to_goal` 是 goal-specific).
  - Force flag (`--force`) → 跳缓存重生.
- **Synthesis cache key**: `_hash` = sha1(goalHash + sorted(bookIds)).
  - Books 改 OR Goal 改 → synthesis 重生.
- Cache hit: `_cached: true` 字段标记, 跳过 LLM 调用直接返回缓存 JSON.

---

## 与 R-LIB 关系 — 分层不冲突

| 层级           | 模块                             | 输出                                |
|----------------|----------------------------------|-------------------------------------|
| **Profile 层** | `app/lib/grounding/`             | 8-field per book + 6-field synthesis (高层视角) |
| **Retrieval 层** | `app/lib/library.js` + `query-expansion.js` | 3-vector chunk-level retrieval (chunk 级证据) |

两层都 feed 到 `designSkeletonOnly` 的 SYSTEM_PROMPT:
- `GROUNDING PROFILE` block 在最上 (高层 book roles + conflicts + excluded).
- `LIBRARY EVIDENCE` block 紧跟 (3 本 top rollup + TOC).
- `COMMUNITY PACK HINTS` block 第三 (Commons sparks).

不替代, 互补.

---

## 与 W6.2 Longform Distillation 关系

- W6.2 ship 后, `buildBookProfile` 接收可选 `opts.bookSparkPack`. 若存在:
  - 用 Book Spark Pack 的 `summary` 作 LLM digest 输入 (低 token, 高信号).
  - 跳过 raw chunks digest (避免吃满 context).
- W6.2 未 ship 时: fallback 用 `library.js` manifest 的 chunks toc + 头 120 字符 snippet (60K 字符 cap).

Grounding 是 W6.2 的消费者, 不是依赖. W6.2 可在 W6.1 ship 后逐步替换 digest 源.

---

## 与 W6.5 Commons 关系

- 公开 Profile 可作 Commons Pack 的子组件. v2.5+ 计划:
  - 用户 A 蒸馏的 Book Grounding Profile (含 fit_to_goal 已 review) 可上传到 Commons.
  - 用户 B 选同本书时, 优先复用 Commons Profile, 再 LLM 重写 `fit_to_goal` 适配 B 的 Goal.
- v0.1 scaffold 不 ship 此分支 — profile 现阶段 user-local.

---

## API 表

### Library / IPC

| IPC                              | Renderer bridge                              | 入参                              | 返回                                  |
|----------------------------------|----------------------------------------------|-----------------------------------|---------------------------------------|
| `grounding:buildProfile`         | `window.ptor.grounding.buildProfile`         | `bookId, goalContract, slug, force` | `{ok, profile}`                       |
| `grounding:getProfile`           | `window.ptor.grounding.getProfile`           | `bookId, slug`                    | `{ok, profile|null}`                  |
| `grounding:refreshAll`           | `window.ptor.grounding.refreshAll`           | `slug, goalContract, bookIds, force` | `{ok, profiles}`                   |
| `grounding:synthesize`           | `window.ptor.grounding.synthesize`           | `slug, goalContract, bookIds, force` | `{ok, synthesis}`                  |
| `grounding:getSynthesis`         | `window.ptor.grounding.getSynthesis`         | `slug`                            | `{ok, synthesis|null}`                |
| `grounding:runForCourse`         | `window.ptor.grounding.runForCourse`         | `slug, goalContract, bookIds, force` | `{ok, profiles, synthesis, role_distribution}` |
| `grounding:progress` (event)     | `window.ptor.grounding.onProgress(cb)`       | —                                 | `{stage, ...}` per step               |

### Node API (`app/lib/grounding/index.js`)

```js
const g = require('./lib/grounding');
const { profiles, synthesis, role_distribution } = await g.runGroundingForCourse(
  slug, goalContract, bookIds,
  { vaultRoot, force: false, onProgress: (stage, extra) => {} }
);
const block = g.renderGroundingBlock(synthesis, profiles); // for SYSTEM_PROMPT
```

---

## Events.jsonl

Each successful `runGroundingForCourse` writes one event:

```json
{
  "ts": "2026-05-13T...",
  "type": "grounding:built",
  "slug": "<curriculum-slug>",
  "book_count": 3,
  "role_distribution": { "primary": 1, "secondary": 2, "supplement": 0 },
  "synthesis_cached": false
}
```

Progress events (streamed via `grounding:progress` IPC channel):
- `grounding:profiles:start` — `{book_count}`
- `grounding:profiles:done`  — `{profile_count}`
- `grounding:synthesis:start`
- `grounding:synthesis:done`

The `_runHarvestAndSkeleton` integration layer additionally emits the
high-level shell event `grounding:start` / `grounding:done` /
`grounding:failed` on the `curriculum:progress` channel.

---

## UI Surface

- **OnboardingScreen** (`app/design/screen-onboarding.jsx`): adds optional
  multi-select picker "选参考书 (可选)" — lists books from `libraryList` IPC.
  Selected `bookIds` ride along to `curriculum:create` as `options.bookIds`.
- **GroundingReviewScreen** (`app/design/screen-grounding-review.jsx`):
  千金 register. Per-book Profile (editable `fit_to_goal`) + Synthesis
  (editable role dropdown). "重建地基 (--force)" button. Routed via
  `'grounding-review'` route in `app/design/app.jsx`.

---

## 实现路径

1. **v1.5 (shipped 2026-05-13)**: 8-field Profile + 6-field Synthesis + cache
   + IPC + Onboarding picker + Review screen + designSkeletonOnly injection.
   LLM bridge mock-safe (fallback to deterministic profile when provider
   unavailable so tests/CI pass).
2. **v1.6**: Longform Distillation (W6.2) populates `bookSparkPack` arg →
   buildBookProfile prefers distilled summary over raw chunks.
3. **v2.5**: Commons reciprocity — public Profile become Commons Pack sub-units.

完整 spec 见 [BLUEPRINT.md §4](../BLUEPRINT.md)。
