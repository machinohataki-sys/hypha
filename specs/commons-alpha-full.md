# Commons Alpha Full (Wave 6.5)

> Status: SHIPPED 2026-05-13 — layered on R-LIB Day 3-6 Commons Alpha
> base. Implements BLUEPRINT.md §12 Commons System — Pack Intelligence
> Card (15 fields) + Security Layer + Source Trust + License Layer.

## 1. Goal

Turn community Packs from "opaque YAML files" into "shoppable signal" —
the user can see what a Pack teaches, who it is for, how trustworthy
the cited sources are, what the license allows, and whether the
content has been scanned for prompt-injection / phishing / executable
payloads before any LLM reads it.

Out of scope this wave: real T4_JUDGE pipeline (Wave 7 Pack Distiller),
license-aware lesson export (Wave 8 Publishing), distributed pubkey
registry (deferred to v0.5 P2P arc).

## 2. Architecture

```
app/lib/commons/
├── pack-intelligence-card.js   PIC schema + ranker (8-factor) + mock LLM
├── security-layer.js           scanPack + sanitizeForLLM + assessSafetyLevel
├── source-trust.js             5-signal weighted 0-100 trust
└── license-layer.js            10 LICENSE_TYPES + 4 usage intents

app/lib/community.js            (R-LIB, lightly enriched — _enrichPack)
app/main.js                     (IPC handlers, _commons* requires)
app/preload.js                  (window.ptor.commons.* bridge)
app/design/screen-library.jsx   (Commons tab UI — 4 indicators per pack)
```

Boundary contract: this wave only ADDS to `community.js`. The base scan
(`_scanPacksDir`) and pack file layout are untouched. Enrichment runs
once per `listPacks()` call, mutation-free, additive only. If the
`commons/` subtree is absent, `community.js` falls through silently.

## 3. Pack Intelligence Card — 15 fields

Per BLUEPRINT §12.3. Each field tagged by source (`meta` | `algo` |
`llm`). `llm`-source fields are MOCKED in v0.1 — deterministic synthesis
from pack metadata. Real T4_JUDGE wiring deferred to Wave 7.

| # | Key | Label (zh) | Type | Source |
|---|---|---|---|---|
| 1  | `recommended_subject`  | 推荐科目             | string   | meta |
| 2  | `audience`             | 适合人群 / 人物群像   | string   | llm  |
| 3  | `recommended_scenes`   | 推荐场景             | string[] | llm  |
| 4  | `primary_value`        | 主要价值             | string   | llm  |
| 5  | `not_for`              | 不适合谁             | string   | llm  |
| 6  | `prerequisites`        | 前置知识             | string[] | llm  |
| 7  | `difficulty_level`     | 难度等级             | enum     | algo |
| 8  | `cognitive_load`       | 认知负荷             | enum     | algo |
| 9  | `stability_tag`        | 稳定性标签           | enum     | algo |
| 10 | `risks_and_defects`    | 风险与缺陷           | string[] | llm  |
| 11 | `usage_method`         | 使用方式             | string   | llm  |
| 12 | `quality_score`        | 质量评分             | 0-100    | algo |
| 13 | `safety_level`         | 安全等级             | enum     | algo |
| 14 | `why_for_you`          | 为什么推荐给当前用户  | string   | algo |
| 15 | `transferable_to`      | 可迁移到哪些 Product | string[] | llm  |

Enum domains:
- `difficulty_level`: 入门 / 进阶 / 专家 / 前沿
- `cognitive_load`: 轻 / 中 / 重 / 极重
- `stability_tag`: 稳定 / 演化中 / 争议 / 过时
- `safety_level`: safe / caution / unsafe / blocked

## 4. 8-factor Ranker

Sort order is NOT popularity (BLUEPRINT §12 explicit). Composite score:

```
score(pack | userContext) = Σ w_i × f_i(pack, userContext)

w = {
  goal_match:        0.20  (substring vs userContext.goal + aliases)
  current_lesson:    0.15  (substring vs userContext.currentLesson.topic)
  mastery_fit:       0.10  (1 - mastery[topic]; weak topic = higher fit)
  current_product:   0.10  (substring vs userContext.products[])
  quality_score:     0.15  (intrinsic; identical to PIC field 12 ÷ 100)
  safety_score:      0.15  (safe=1.0 / caution=0.6 / unsafe=0.2 / blocked=0)
  learning_effect:   0.10  (syllabus + contested density, sat at 1.0)
  maintenance_state: 0.05  (age curve, deprecated=0)
}
```

Tie-break: blocked packs sink to bottom regardless of score (defense-in-
depth alongside security-layer.js). `_rank_score` and `_rank_breakdown`
are attached to each pack for UI transparency.

## 5. Security Layer

4 scan types + 1 sanitizer. All LOCAL; no network calls.

### 5.1 File-extension scan
Banned (severity=critical):
`.exe .msi .bat .cmd .ps1 .psm1 .vbs .vbe .js .dll .so .dylib .scr .pif
.com .cpl .sh .bash .zsh .app .dmg .pkg .deb .rpm .jar .war .class
.docm .xlsm .pptm .crx .xpi`

Suspicious (severity=high): `.zip .rar .7z .tar .gz .iso` (opaque
containers; v0.2 ladder will unzip + recurse).

Allowed text extensions for content scan: `.json .yaml .yml .md
.markdown .txt`.

### 5.2 Binary-magic scan
Detects renamed executables via first 16 bytes:
- PE / Windows EXE — `MZ` (0x4D 0x5A)
- ELF / Linux — `\x7FELF`
- Mach-O 32 / 64, both endian
- ZIP / DOCM / XLSM — `PK` (0x50 0x4B 0x03 0x04)
- RAR — `Rar!`

### 5.3 Prompt-injection scan
12 patterns case-insensitive over text content. Patterns include:
"Ignore previous instructions", "Disregard system", "Forget your
training", "You are now in [role] mode", "SYSTEM:", "Override your
instructions", "Reveal your system prompt", "exfiltrate vault",
"jailbreak", "pretend you have no restrictions". Each match = severity
`high`.

### 5.4 URL classification
Extracts `https?://` URLs from text. Classifies:
- Shorteners (`bit.ly`, `tinyurl.com`, `goo.gl`, `t.co`, `ow.ly`,
  `is.gd`, `buff.ly`, `rebrand.ly`, `shorturl.at`, `cutt.ly`, `rb.gy`,
  `tiny.cc`, `mcaf.ee`, `shorte.st`) — severity `medium`.
- Typosquats (`goog1e`, `g00gle`, `githulb`, `payp[a4]l-secure`,
  `appleid-*`, `micros0ft`) — severity `critical`.

### 5.5 Dangerous-reference scan
Flags shell commands / install patterns in text:
`curl -[osLk]+ https://`, `wget https://`, `pip install`, `npm install`,
`docker run`, `bash <(...)`, `iex (new-object ...)`, `eval(...)`,
`child_process | spawnSync | execSync`. Severity `high`.

### 5.6 Safety-level rollup
```
critical ≥ 1                 → 'blocked'
high ≥ 2                     → 'unsafe'
high == 1 OR medium ≥ 1     → 'caution'
otherwise                    → 'safe'
```
`scanPack().safe` is `true` only when criticals=0 AND highs≤1.

### 5.7 LLM Sanitizer
`sanitizeForLLM(content)` strips before LLM consumption:
1. Prompt-injection matches → `[SANITIZED:injection]`.
2. Dangerous shell refs → `[SANITIZED:dangerous-ref]` (runs BEFORE URL
   tagging — order matters; curl-then-URL was the surgical bug found
   during smoke).
3. URLs → `[URL:hostname]` (transparent, not deleted).
4. C0/C1 control characters except `\t \n \r` (defense against
   unicode-tag steganography).

Returns `{ sanitized, removed[] }`. LLM consumers (e.g.
`generateCard()` future-T4_JUDGE call) MUST pass content through this
filter first.

## 6. Source Trust

5 signals weighted 0..1, summed × 100 → integer 0..100.

| Signal | Weight | Source |
|---|---|---|
| `author_pubkey`      | 0.20 | curator ∈ KNOWN_CURATORS allowlist |
| `ratified_by_count`  | 0.25 | `min(1, ratifiers / 5)` |
| `age_months`         | 0.10 | sweet-spot curve: <1mo=0.5, 1-18=1.0, 18-24=0.7, 24-36=0.4, >36=0.1 |
| `citations_count`    | 0.20 | `min(1, recommended_sources / 8)` |
| `source_reputation`  | 0.25 | avg of per-source domain rep (SOURCE_REPUTATION_DOMAINS lookup, fallback 0.50 unknown / 0.75 title-only book) |

Domain reputation table is curated and local; quarterly review per §12.5.
Edu / canonical (`plato.stanford.edu`, `arxiv.org`, `nature.com`) = 0.95.
Reference (`britannica.com`, `wikipedia.org`) = 0.65-0.80. Curated long-
form (`lesswrong.com`, `substack.com`, `medium.com`) = 0.40-0.65.

`isPackStale()` delegates to `community.js` to keep the >12mo threshold
single-sourced.

## 7. License Layer

10 LICENSE_TYPES strictly enumerated:
`CC0 / CC-BY / CC-BY-SA / CC-BY-NC / CC-BY-NC-SA / MIT / Apache-2.0 /
GPL-3.0 / proprietary / unknown`.

`unknown` is treated as MOST restrictive (private_learn only). Defaults
keep users safe when license field is absent or unparseable.

### 7.1 Permission matrix (4 intents × 10 types)

| License       | private_learn | public_lesson | commercial | modify | attribution | share-alike |
|---------------|:-:|:-:|:-:|:-:|:-:|:-:|
| CC0           | ✓ | ✓ | ✓ | ✓ | — | — |
| CC-BY         | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| CC-BY-SA      | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| CC-BY-NC      | ✓ | ✓ | — | ✓ | ✓ | — |
| CC-BY-NC-SA   | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| MIT           | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Apache-2.0    | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| GPL-3.0       | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| proprietary   | ✓ | — | — | — | ✓ | — |
| unknown       | ✓ | — | — | — | ✓ | — |

### 7.2 Canonicalization

Free-form strings → canonical type via LICENSE_ALIASES (51 entries
across the 10 types). Canonicalization uses LONGEST-PREFIX-MATCH —
declaration order does NOT win. Without longest-match, `cc-by-nc-sa 4.0`
silently downgrades to `cc-by` (surgical bug caught during smoke; fixed
by sorting aliases by length descending before prefix scan).

### 7.3 Attribution

`formatAttribution(pack)` returns e.g.:
- `Pack "柏拉图" by hypha-org, CC-BY.`
- `Pack "Spinoza" by hypha-org — CC0 (public domain).`
- `Pack "X" by Y — license unspecified; private learning only.`

## 8. R-LIB Integration

`community.js` lightly enriched (+30 LOC):
- `_loadCommonsEnrichers()` — lazy require of the 3 sibling libs;
  returns null on load failure (keeps community.js usable in lean tests).
- `_enrichPack(pack, enrichers)` — additive, mutation-free; attaches
  `_safety_level`, `_safety_scan`, `_trust`, `_license` to each pack.
- `listPacks()` maps through `_enrichPack` only when enrichers present.

Boundary: this wave does NOT change `queryPacks` sort order. Wave 6.5's
8-factor ranker is exposed separately via `commons:rankPacks` IPC; the
old `queryPacks` (trust + recency only) is preserved for the legacy R-LIB
Day 6 UI surface.

## 9. W6.1 Grounding hook (forward)

Packs can serve as Grounding sources for Lesson generation. The
contract: Lesson System reads pack via `commons:sanitize` → only
sanitized output reaches the LLM. Raw pack content never directly
enters a model context. The 15-field PIC card itself is a sanitized
intermediate (mock LLM output is deterministic; future T4_JUDGE call
will run on sanitized pack).

## 10. IPC surface

| Channel | Args | Returns |
|---|---|---|
| `commons:generateCard`    | `{ pack, userContext }`   | `{ ok, card }` |
| `commons:rankPacks`       | `{ packs, userContext }`  | `{ ok, packs }` |
| `commons:recommendReason` | `{ pack, userContext }`   | `{ ok, reason }` |
| `commons:scanPack`        | `{ packPath }`            | `{ ok, scan }` |
| `commons:sanitize`        | `{ content }`             | `{ ok, sanitized, removed }` |
| `commons:safetyLevel`     | `{ scan }`                | `{ ok, level }` |
| `commons:trustScore`      | `{ pack }`                | `{ ok, score, signals, weights }` |
| `commons:license`         | `{ pack }`                | `{ ok, license }` |
| `commons:checkUsage`      | `{ pack, intent }`        | `{ ok, allowed, reason, license }` |

Renderer bridge: `window.ptor.commons.{generateCard, rankPacks,
recommendReason, scanPack, sanitize, safetyLevel, trustScore,
parseLicense, checkUsage, formatAttribution}`. `formatAttribution` is
a pure-renderer shim — no IPC round-trip.

## 11. UI surface

`app/design/screen-library.jsx` CommonsTab. Each pack row now shows:
1. Existing header + ratification meta (preserved from R-LIB Day 6).
2. NEW indicator row (4 badges on a dashed-rule strip):
   - 安全 · safe/caution/unsafe/blocked (color-coded; blocked draws
     inset oxblood border on the whole card).
   - 信任 · 0-100 + 5-bar mini spark (title-hover for per-signal value).
   - 许可 · canonical license string (title-hover for usage summary).
   - 推荐 · 1-sentence why_for_you when card is loaded.
3. NEW collapsible "展开 Pack Intelligence Card · 15 字段" details — lazy
   loads via `window.ptor.commons.generateCard` on first expand;
   renders all 15 fields as labelled rows in 千金 manuscript register
   (Garamond + brass hairline + mono labels, no emoji / no exclamations).
4. Existing "展开 内容" details preserved below.

## 12. Tests

`__tests__/commons-alpha-full.test.js` — 16 test.todo() placeholders
covering all 4 modules + integration surfaces. Real test bodies land
with Wave 7 when T4_JUDGE is wired.

## 13. Constraints honored

- Real implementations: extension scan, URL extract, regex injection,
  binary magic, license parse, trust score, ranker. NOT mocked.
- Only LLM-source PIC fields mocked (deterministic stub keyed off pack
  meta — produces stable output for snapshot tests in Wave 7).
- `community.js` core untouched; +30 LOC enrichment only.
- No W6.1 / W6.2 / W6.3 / W6.4 files modified.
- Total diff: ~880 LOC across 9 files (4 new lib + spec + tests +
  community.js + main.js + preload.js + screen-library.jsx).
