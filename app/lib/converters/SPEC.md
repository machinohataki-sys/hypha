# HYPHA-MD-SPEC v1

> 2026-05-19. 定义 HYPHA file-converter 产出的 `.md` 必须满足的格式契约.
> 消费者 = LLM context window (course generation pipeline). 优化目标 = token-density + structure-extraction.

## Why a spec

没有显式 MD output spec, 每个 converter 优化方向不同, 质量不可测. 此 spec 锁住: heading 检出 / paragraph 切分 / table 语义 / image refs / code blocks. 下游 chunker + lesson-body-generator 全部假设这些规则成立.

## Frontmatter (required)

每个 file-converter 产出的 `.md` 必须以 YAML frontmatter 开头:

```yaml
---
source_path: /abs/path/to/orig.pdf
source_ext: pdf
parsed_level: native | markitdown | raw-extract | raw-stash | ocr | cached
fidelity_score: 0.78
fidelity_tier: high | mid | low
chars: 234567
heading_count: 42
page_count: 320
extracted_at: 2026-05-19T10:23:11Z
---
```

注: frontmatter 由 library.addBook 注入, 非 converter 本身职责. Converter 输出 mdText body, library 包 frontmatter.

## MUST (违反则 spec-validator FAIL)

1. **Reading order preserved** — sections in source-order, ! shuffle.
2. **ATX headings** — `# H1` 到 `###### H6`. 禁 setext (`====` / `----`). Heading 文本同行.
3. **Lists** — `-` (无序) / `1.` (有序). 2 或 4 空格缩进嵌套. 禁 `*` / `+` 作 unordered.
4. **Fenced code blocks** — ` ``` ` 围栏 + 可选语言提示 (e.g. ` ```python `). 禁 4-space-indent code.
5. **Paragraph breaks** — 单空行 (`\n\n`) 间隔. ! 句中插入.
6. **GFM tables** — pipe + separator row:
   ```
   | col1 | col2 |
   |------|------|
   | a    | b    |
   ```
7. **Images** — `![alt](path)`. Alt 可提取时必填.
8. **Math** — inline `$E=mc^2$` 或 fenced ` ```math `.
9. **Footnotes** — Pandoc-style `text[^1]` + `[^1]: body` end-of-section/file.
10. **Blockquotes** — `>` 行首. 禁 nested HTML `<blockquote>`.

## MAY (允许 ! 必须)

- `~~strikethrough~~`
- `---` horizontal rule
- `**bold**` / `_italic_`
- `[text](url)`

## MUST NOT (违反则 spec-validator FAIL)

- **HTML passthrough** — 禁 `<div>` / `<span>` / `<p>` / `<table>` / `<a>` / `<img>` 等在 MD body 内. (YAML string 内 HTML 可)
- **Inline style attributes** — `style="..."` 任何位置禁.
- **Raw XML preamble** — `<?xml version=...?>` 禁出现.
- **Word/PDF artifacts** — 段内浮动页码 / 每页重复 header-footer / "Click to enlarge" 样板.
- **Encoded entities in content** — `&nbsp;` / `&amp;` 写明文 (code block 内除外).

## Quality dimensions (per Leo top-5)

Course-gen utility ranking (10 = catastrophic if missing, 0 = vanity):

| Rank | Dimension | Weight |
|---|---|---|
| 1 | Reading order (spine/ToC) | 10 |
| 2 | Heading hierarchy H1-H6 | 10 |
| 3 | Paragraph integrity | 9 |
| 4 | Lists with nesting | 8 |
| 5 | Code blocks with lang | 8 |
| 6 | Tables (semantic) | 7 |
| 7 | Math (LaTeX > raster) | 7 |
| 8 | Footnotes/citations | 6 |
| 9 | Image alt-text | 5 |
| 10 | Block quotes | 4 |
| 11 | Bold/italic emphasis | 3 |
| 12 | Page numbers | 2 |
| 13 | Fonts/colors/columns | 0 (anti-feature) |

## Compliance check

`app/lib/converters/spec-validator.js` exports `validateSpec(mdText) → {valid, violations}`. 调用方: `fidelity-scorer.js` 计 composite.

## Fidelity tiers (per fidelity-scorer.js)

- **high** ≥ 0.80 — 直接 accept, ! confession
- **mid** 0.50-0.80 — accept + flag confession layer
- **low** < 0.50 — auto-rerun 下一级 fallback

## v2 native PDF output contract (2026-05-20)

`native-pdf-v2.js` adds heading + multi-column awareness vs v1 (`pdf-parse` wrapper):

### Heading 启发式
- Font-size distribution sampled from first 20 pages.
- Top 5% font-size + line-length < 80 chars → `# H1`
- Top 15% font-size + line-length < 100 chars → `## H2`
- Body size = median (50th percentile).

### Multi-column reading order
- Items sorted by `(|y_diff| > 2) ? y_desc : x_asc`.
- Lines grouped by y proximity (< 2 unit) so a 2-column page reads left-block-first per band.

### Image-heavy page handling
- Per page: count `pdfjs.OPS.paintImageXObject` ops / total ops.
- Page with ratio > 0.5 + text-items < 10 → `<!-- 待 OCR -->` placeholder.
- Whole-book ratio > 0.7 → triggers full OCR via `app/lib/ocr.js` `ocrPdf()`.

### Fallback contract (inline, transparent to caller)
- pdfjs-dist ESM import fails → inline call to v1 `convertPdfNative` (pdf-parse).
- PDF parse throws (corrupt / encrypted) → inline v1.
- Output < 200 chars (sparse extract) → inline v1.
- v1 also fails → return `{ok: false, reason}` → file-converter L2/L3/L4 chain.

### Output `stats` schema
```json
{
  "ms": 1234,
  "pages": 42,
  "total_chars": 89012,
  "ext": "pdf",
  "method": "pdfjs-dist-direct",
  "image_heavy_pages": 3,
  "h1_threshold": 18.5,
  "h2_threshold": 14.2
}
```

When OCR triggers, `method` becomes `"pdfjs-detect+ocr"` and `level: "ocr"`.

## Versioning

v1. Breaking change bump major. Add-only bump minor.
