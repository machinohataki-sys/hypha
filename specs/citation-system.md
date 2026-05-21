# Citation System (W7.3)

Global, cross-module citation primitives for Hypha. Promotes the W6.5
Commons-only Source Trust + License Layer up to every surface where a
claim needs a verifiable referent: Lesson body, Note frontmatter, Spark
source field, Research Radar report nodes, future Commons exports.

Source of truth: BLUEPRINT.md §12.7 (Source Trust & License) + §22.2
(Citation surface), ROADMAP v2.2.

## Files

- `app/lib/citation-system/citation.js` — primitives + token parser + render
- `app/lib/citation-system/external-link-scanner.js` — URL extract + 4-tier classifier
- `app/lib/citation-system/copyright-boundary.js` — 4-level risk + intent matrix
- `app/lib/citation-system/global-trust.js` — cross-type trust composer
- `app/lib/citation-system/index.js` — orchestrator + composed helpers

## 7 Citation Types

`CITATION_TYPES` (citation.js):

| Type | source_id shape | source_url | Trust source |
|---|---|---|---|
| `book` | sha1 book id | optional | W6.5 source-trust via pack-shape shim + book bonus |
| `pack` | pack slug | optional | W6.5 source-trust (Commons full pipeline) |
| `paper` | arXiv id / DOI | required | URL classifier + peer-review hint bonus |
| `web_url` | URL (also source_id) | required | URL classifier tier base |
| `lesson` | `slug/N` | none | 0 (user-owned internal) |
| `note` | `slug/note_id` | none | 0 (user-owned internal) |
| `spark` | `slug/spark_id` | none | 0 (user-owned internal) |

Citation primitive is a frozen plain object with `type`, `source_id`,
`source_url`, `page_or_idx`, `snippet` (≤500 char), `attribution`,
`created_at`.

### Token compatibility

`parseCitationToken(text)` accepts the existing R-LIB Day 5 token shapes
plus the new W7.3 prefixes:

- `[CITE:<book_id>:<chunk_idx>]` — book (R-LIB default; no prefix needed)
- `[CITE:pack:<pack_id>]` — Commons pack
- `[CITE:paper:<arxiv_id>]` — paper
- `[CITE:url:<opaque_id>]` — web_url (normalised to `web_url` type)
- `[CITE:lesson:<slug/N>]`
- `[CITE:note:<slug/note_id>]`
- `[CITE:spark:<slug/spark_id>]`

This keeps lesson-body-generator's `_extractCitations` (the existing
canonical parser for inline lesson markers) interoperable: any token it
emits parses identically through W7.3.

## 4-Tier External Link Classification

`external-link-scanner.classifyURL(url)` returns one of:

| Tier | Trigger | Reputation base |
|---|---|---|
| `safe` | Domain reputation ≥ 0.85 in W6.5 SOURCE_REPUTATION_DOMAINS | 85 |
| `caution` | Mid-reputation (0.50–0.84), unknown domain, or known shortener | 50 (30 for shortener) |
| `unsafe` | Low-reputation (<0.50) domain, or malformed URL | 20 |
| `phishing` | Typosquat pattern match (goog1e, payp4l, etc.) | 0 |

W6.5 SUSPICIOUS_DOMAINS (`bit.ly`, `t.co`, etc.) feed both:
1. The bare-domain extractor — promotes `bit.ly/x` → `https://bit.ly/x` so
   classifyURL can parse normally.
2. The shortener-tier classifier — never `safe`, always at least `caution`.

`scanContentForExternalLinks(text)` returns:
```
{ urls: [{ url, tier, reason, reputation, domain }], counts: { safe, caution, unsafe, phishing }, worst_tier }
```

## 4-Level Copyright Boundary

`copyright-boundary.assessCopyrightRisk({ content, citation, intent, pack? })`
returns `{ risk_level, reason, alternative_suggested, license_check? }`.

| Risk | Triggers |
|---|---|
| `low` | ≤500 char excerpt, internal source, or `private_learn` intent |
| `medium` | 500–1500 char excerpt for `public_lesson` or `commercial` |
| `high` | >1500 char excerpt, or `commercial` intent on web_url long quote |
| `block` | License denies intent (W6.5 license-layer says no), OR `book` full-chapter for `public_lesson`/`commercial`, OR `paper` full-text for commercial |

4 intents: `private_learn` (most permissive) → `public_lesson` →
`commons_share` → `commercial` (strictest). License denial via W6.5
`checkUsage` always escalates to `block` regardless of length.

`getBoundaryWarning(risk)` returns a one-sentence plain-Chinese warning for
UI surface — empty string for `low`, prefixed warning for medium+.

## Global Trust Formula

`global-trust.computeGlobalTrust(citation, opts?)` returns
`{ score: 0–100, breakdown }`.

```
score(citation) =
  switch citation.type:
    pack    → W6.5.source-trust.computeTrustScore(opts.pack)
    book    → W6.5.source-trust.computeTrustScore(book-as-pack-shim) + 15
    paper   → TIER_BASE[classifyURL(source_url).tier] + 10 if peer-review hint
    web_url → TIER_BASE[classifyURL(source_url).tier]
    lesson  → 0
    note    → 0
    spark   → 0
```

`TIER_BASE = { safe: 85, caution: 50, unsafe: 20, phishing: 0 }`.
Peer-review hints: matching `arxiv|openreview|nature|science|peer-reviewed|
journal|doi: 10\\.` in `citation.attribution` or `source_url`.

`rankCitations(citations, optsPerCitation?)` is a stable sort by trust DESC.
Preserves original order on ties. Returns a new array; never mutates.

## Relationship to W6.5 Commons

W7.3 REUSES, does not duplicate:

- `commons/source-trust.computeTrustScore` — pack score + book score (via
  pack-shape shim in global-trust.js)
- `commons/source-trust.SOURCE_REPUTATION_DOMAINS` — URL reputation map
  consumed by external-link-scanner.js
- `commons/security-layer.SUSPICIOUS_DOMAINS` — shortener list for URL
  classifier + bare-domain extractor
- `commons/license-layer.checkUsage` — license permission check inside
  assessCopyrightRisk when citation.type='pack' and `opts.pack` provided

Total reused-W6.5 surface: ~12 lines of W6.5 reads. Zero internal W6.5
edits. If W6.5 evolves (adds new SOURCE_REPUTATION_DOMAINS entry, new
license type), W7.3 picks it up automatically.

## Relationship to R-LIB Day 5

Lesson-body-generator.js owns the canonical `_extractCitations` flow
(post-parses `[CITE:b:c]` markers out of validated body JSON, resolves
each against ranked sources, returns `evidence_cite[]`). W7.3 LAYERS on
top: after `_extractCitations` returns, the integration patch annotates
each entry with `_trust_score` and `_risk_level` via citation-system.
The W7.3 surface is purely additive — never rewrites the original
evidence_cite shape, never blocks body generation on annotation failure.

## Relationship to W6.3 Research Radar

`research-radar/auto-actions.storeAsNote` now passes the rendered report
markdown through `citation-system.harvestCitationsFromText` before
calling `engine.addNode`. The resulting `citations[]` and
`citations_worst_tier` land in node frontmatter. Notebook surface reads
those fields directly — no extra IPC round-trip when rendering the node.

## 4 Integration Points

1. `app/lib/lesson-body-generator.js` — annotates each `evidence_cite[]`
   entry with `_trust_score` + `_risk_level` after R-LIB extracts markers.
2. `app/lib/product-spark.js` — when `sparkData.source.url` present,
   builds a citation primitive + global-trust score, persists under
   `spark.citation` in the markdown frontmatter.
3. `app/lib/research-radar/auto-actions.js` — `storeAsNote` harvests
   URLs from the report markdown and writes them as a `citations[]`
   frontmatter slot on the resulting raw-layer node.
4. `app/lib/web-note-engine/graph.js` — `addNode` auto-harvests URLs
   from `content` into `frontmatter.citations[]` if the caller did not
   already supply one. Lifts citation surface uniformly across notes,
   sparks, and radar nodes.

## IPC + Renderer Surface

main.js handlers (commented `// W7.3 Citation + Global Trust`):

- `citation:create` — `(args)` → `{ ok, citation }`
- `citation:parse` — `({ text })` → `{ ok, tokens[] }`
- `citation:render` — `({ citation, language })` → `{ ok, markdown }`
- `citation:format` — `({ citation })` → `{ ok, attribution }`
- `citation:extractURLs` — `({ text })` → `{ ok, urls[] }`
- `citation:classifyURL` — `({ url })` → `{ ok, tier, reason, reputation, domain }`
- `citation:scanContent` — `({ text })` → `{ ok, urls[], counts, worst_tier }`
- `citation:copyrightRisk` — `(args)` → `{ ok, risk_level, reason, alternative_suggested, license_check? }`
- `citation:getBoundary` — `({ risk })` → `{ ok, warning }`
- `citation:globalTrust` — `({ citation, opts })` → `{ ok, score, breakdown }`
- `citation:rank` — `({ citations, optsPerCitation })` → `{ ok, ranked[] }`

preload.js binds `window.ptor.citation = { create, parse, render, format,
extractURLs, classifyURL, scanContent, copyrightRisk, getBoundary,
globalTrust, rank }`.

## UI Hook (placeholder)

`app/design/screen-lesson-chat.jsx` LessonBodyPreview renders an extra
`引用 · 来源` block when `body.evidence_cite[]` is non-empty:

- Each citation row shows the title + a monospace `trust·NN` badge
  coloured by tier (green ≥75, brass 50-74, orange 25-49, red <25).
- When any row's `_risk_level` is `high` or `block`, a side-bordered
  warning rail renders below the list with a plain-Chinese boundary
  message ("仅作私人学习; 公开发布前请改为短引文 + 链回原书").

Visual polish is intentionally minimal — this is a placeholder so the
data path is testable end-to-end. Final design pass tune happens in a
subsequent UI wave once Course Trust Panel v2 lands.

## Constraints respected

- ≤ 700 lines total diff
- Zero edits to `commons/source-trust.js`, `commons/license-layer.js`,
  `commons/security-layer.js` internals — only public exports consumed
- Integration patches are best-effort try/catch; failure never blocks
  the host code path (lesson body, spark, radar, note)
- No new external dependencies
