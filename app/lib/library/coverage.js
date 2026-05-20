'use strict';
// HYPHA · Library Coverage (Phase E.0, 2026-05-18)
//
// User feedback 2026-05-18: 创课时若 Library ! 含 topic 相关书, 生成质量低
// (LLM 走 training-cutoff 默认 = AMD-MEOW-P7 anti-slop 靶心). Council Phase B
// 已 ship GraphRAG. Phase E = 创课前 GATE: 检 Library 对 goal 的覆盖, 若不够
// 显推荐书 + 上传/跳过 fork.
//
// 2 API:
//   assessCoverage({goal, archetype, vaultRoot, settings}) → 现 Library 覆盖度
//   recommendBooks({goal, archetype, settings}) → LLM 推 3-5 canonical sources
//
// 阈值:
//   has_coverage = true IFF distinct_books ≥ 2 AND total_hits ≥ 5 (graph-rag k=10)
//   否则 has_coverage = false → 调 recommendBooks
//
// Anti-hallucination 约束 (recommendBooks):
//   - 仅推 LLM 确信存在的 + 含真 author
//   - HUMANITIES 偏原作 primary + 注疏 secondary
//   - TECH 偏 paper 原文 + 经典教科书
//   - 含 suggested_format (PDF/EPUB/MD/HTML)
//   - 若 goal 太模糊 / LLM 不 confident → 返 [] + reason

const COVERAGE_MIN_DISTINCT_BOOKS = 2;
const COVERAGE_MIN_HITS = 5;
const COVERAGE_GRAPH_K = 10;
// 2026-05-18 user lock: 3-5 books was too thin; widened to 8-10 so user has
// real choice without overwhelming. Also drives _sanitizeBookEntry slice cap.
const RECOMMEND_MAX_BOOKS = 10;
const RECOMMEND_MIN_BOOKS = 8;

const ARCHETYPE_SOURCE_HINT = Object.freeze({
  'HUMANITIES': 'Prefer (a) primary 原作 by the named figure / school, (b) authoritative 注疏 / commentary in target language. Avoid pop-sci synopsis.',
  'TECH-CONCEPT': 'Prefer (a) seminal paper / original publication, (b) university-level textbook citing it. Avoid blog summaries.',
  'TECH-PROC': 'Prefer (a) the canonical reference / spec / API guide, (b) a textbook with practical chapters. Avoid tutorials.',
  'LANG-ACQ': 'Prefer (a) graded reader for the target level, (b) reference grammar in user\'s native language. Skip dictionaries.',
  'DECL-MASS': 'Prefer (a) authoritative reference / handbook, (b) recent peer-reviewed digest. Avoid Wikipedia-rewrites.',
  'MINDSET': 'Prefer (a) primary text by the canonical figure / school, (b) clinical or scholarly anthology. Avoid self-help paraphrase.',
});

const RECOMMEND_SYSTEM_PROMPT = `You are a HYPHA Library Curator. Given a user's learning goal + archetype, recommend 8-10 canonical reading sources the user should ingest BEFORE the curriculum is generated. Without these in the user's Library, lesson generation falls back to LLM training-cutoff knowledge — which is exactly what HYPHA's anti-slop layer fights.

OUTPUT — STRICT JSON. No prose, no markdown fences.

SCHEMA:
{
  "books": [
    {
      "title": "<original-language title; include CN/JP/etc. as published>",
      "title_pinyin_or_romaji": "<optional, when non-Latin script>",
      "author": "<real author, full name>",
      "year": <int year of first publication, omit if uncertain>,
      "language": "<primary language: zh | en | ja | fr | de | ...>",
      "why_canonical": "<30-80 字, cite the goal by name: which aspect of the goal does this book ground? e.g. '马尔克斯式魔幻现实主义原典 — 直接喂 primary_focus 的语感与结构骨架; 汉语短篇创作可借鉴节奏分配'>",
      "suggested_format": "PDF" | "EPUB" | "MD" | "HTML" | "DOCX",
      "category": "primary" | "secondary",
      "personal_fit_score": <0..1, REQUIRED — how WELL this fits THIS user's goal, NOT how famous. 0.9 = perfect fit; 0.5 = generic mid-fit; <0.3 = avoid recommending>,
      "popularity_score": <0..1, REQUIRED — how known/cited the book is in the world. 0.9 = household name; <0.3 = niche>,
      "tradeoff_note": "<optional ≤80 字 when fit + popular diverge by > 0.3>"
    },
    ...
  ],
  "confidence": <0..1>,
  "notes": "<optional ≤40 字 caveat about availability / edition>"
}

CONSTRAINTS:
- 8-10 entries (8 minimum, 10 maximum). Range gives user choice without overwhelming.
- ! invent titles / authors / years. If unsure → set confidence < 0.6 + drop the entry.
- Each entry MUST have title + author + language + why_canonical + personal_fit_score + popularity_score. year + ISBN OPTIONAL.
- why_canonical MUST be 30-80 字 (NOT a terse 1-clause label). Cite goal by name. Cite which dimension of the goal this book grounds (lineage / output_form / level / timeline at least one explicit reference).
- For archetypes mixing East+West canon, include BOTH lineages if relevant.
- "primary" = original work by the named figure; "secondary" = scholarly commentary / classic textbook.
- Forbidden: emoji, exclamation marks, "great choice!", "amazing book!".
- If goal is too vague / not actually mappable to canonical sources → return {books: [], confidence: 0, notes: "<reason>"}.
- AVOID: Wikipedia, blog posts, Reddit, generic study guides. PREFER: peer-reviewed, university-press, archival.

Return STRICT JSON only.`;

// Phase F.2 (2026-05-18) — fit-over-popular variant. Triggered when caller
// passes crystallizedTags. Replaces "canonical" framing with "best-fit for
// THIS user's specific cut". Demands cold/niche picks when niche_factor=high.
const RECOMMEND_FIT_OVER_POPULAR_PROMPT = `You are a HYPHA Library Curator (fit-mode). The user's goal has been CRYSTALLIZED through multi-choice refinement — you have specific tags (primary_focus / output_form / current_level / niche_factor). Your job: recommend 3-5 books that BEST FIT this user's specific cut, NOT books that happen to be famous.

CORE RULE — read twice:
  DO NOT pick popular books just because they're popular.
  Pick books that BEST MATCH this user's specific {primary_focus + output_form + current_level + timeline} configuration.
  COLD / NICHE books are welcome and PREFERRED if they fit better than the popular alternatives.

Examples (illustrative — DO NOT copy verbatim):
  - Goal: "川端式静默 + 短篇 + 汉语 + 5y". Popular pick = 百年孤独 (BAD — 魔幻现实 ≠ 静默 + 西语 ≠ 汉语). Fit pick = 川端 雪国 + 中岛敦 山月记 (less popular than 百年孤独, far better fit).
  - Goal: "transformer attention 复现 + Python". Popular pick = "Deep Learning" (Goodfellow, BAD — too broad, no transformer focus). Fit pick = "Attention Is All You Need" paper + Karpathy's nanoGPT (cold-ish but exact fit).

OUTPUT — STRICT JSON, no prose, no markdown fences.

SCHEMA:
{
  "books": [
    {
      "title": "<original-language title>",
      "title_pinyin_or_romaji": "<optional, when non-Latin>",
      "author": "<real author>",
      "year": <int year, omit if uncertain>,
      "language": "<zh | en | ja | fr | de | ...>",
      "why_canonical": "<≤30 字 WHY this matches THIS user's cut. Cite primary_focus or output_form by name.>",
      "suggested_format": "PDF" | "EPUB" | "MD" | "HTML" | "DOCX",
      "category": "primary" | "secondary",
      "personal_fit_score": <0..1, REQUIRED — how well it fits THIS user's cut>,
      "popularity_score": <0..1, REQUIRED — how famous it is in the world>,
      "tradeoff_note": "<REQUIRED when personal_fit_score - popularity_score > 0.3 OR < -0.3. Else empty string. ≤60 字 e.g. '冷书但精确切合 X 目标' or '热门但偏题, 不推'>"
    }
  ],
  "confidence": <0..1>,
  "notes": "<optional ≤40 字 caveat>"
}

CONSTRAINTS:
- 8-10 entries (8 minimum, 10 maximum). Range gives user choice without overwhelming.
- When tags.niche_factor = "high" → AT LEAST 2 niche/cold picks (popularity_score < 0.4 AND personal_fit_score > 0.7).
- When tags.niche_factor = "low" → can lean popular but still justify fit explicitly.
- ! invent titles / authors / years. If unsure → drop the entry + lower confidence.
- Each entry MUST have personal_fit_score + popularity_score + the 4 base required fields.
- why_canonical MUST be 30-80 字, cite primary_focus / output_form / level by NAME.
- tradeoff_note REQUIRED when |fit - popularity| > 0.3.
- ! generic "groundbreaking work" reasoning. ! "must-read for any X learner".
- Forbidden: emoji, !, "great choice!", "amazing book!".
- For Asian / non-English canon: include language in original script.
- AVOID Wikipedia / blogs / Reddit / generic study guides.

Return STRICT JSON only.`;

/**
 * Assess Library coverage for a goal. Reads graph-rag.queryGraph + counts.
 *
 * @param {{goal: string, archetype?: string, vaultRoot: string, settings?: object}} args
 * @returns {Promise<{has_coverage: boolean, hit_count: number, book_count: number, hits: Array, threshold: {min_books: number, min_hits: number}}>}
 */
async function assessCoverage({ goal, archetype, vaultRoot, settings } = {}) {
  if (!goal || typeof goal !== 'string' || !goal.trim()) {
    return _emptyCoverage('goal required');
  }
  if (!vaultRoot) return _emptyCoverage('vaultRoot required');

  let hits = [];
  try {
    const graphRag = require('../graph-rag');
    hits = await graphRag.queryGraph({
      courseGoal: goal,
      archetype: archetype || (settings && settings._archetype) || null,
      k: COVERAGE_GRAPH_K,
      vaultRoot,
      settings,
    });
    if (!Array.isArray(hits)) hits = [];
  } catch (_) {
    // graph-rag failure → try BM25 fallback by book listing
    hits = [];
  }

  // If graph-rag is empty / failed, still surface what books EXIST in Library
  // (regardless of relevance) so the UI can show "Library has N books total, 0 match this goal".
  let totalLibraryBooks = 0;
  try {
    const libraryMod = require('../library');
    if (libraryMod && typeof libraryMod.listBooks === 'function') {
      totalLibraryBooks = libraryMod.listBooks(vaultRoot).length;
    }
  } catch (_) { /* listBooks failure tolerated */ }

  const distinctBooks = new Set();
  for (const h of hits) {
    if (h && h.book_id != null) distinctBooks.add(String(h.book_id));
  }
  const hitCount = hits.length;
  const bookCount = distinctBooks.size;

  const has_coverage = bookCount >= COVERAGE_MIN_DISTINCT_BOOKS && hitCount >= COVERAGE_MIN_HITS;

  return {
    has_coverage,
    hit_count: hitCount,
    book_count: bookCount,
    total_library_books: totalLibraryBooks,
    hits: hits.slice(0, 10).map(h => ({
      book_id: h.book_id,
      book_title: h.book_title || null,
      chunk_idx: h.chunk_idx,
      score: Number.isFinite(h.score) ? h.score : null,
      snippet: (h.snippet || '').slice(0, 200),
    })),
    threshold: {
      min_books: COVERAGE_MIN_DISTINCT_BOOKS,
      min_hits: COVERAGE_MIN_HITS,
    },
  };
}

function _emptyCoverage(reason) {
  return {
    has_coverage: false,
    hit_count: 0,
    book_count: 0,
    total_library_books: 0,
    hits: [],
    threshold: { min_books: COVERAGE_MIN_DISTINCT_BOOKS, min_hits: COVERAGE_MIN_HITS },
    error: reason,
  };
}

/**
 * Recommend canonical books for goal. Uses T3_MID router (cheap). Anti-hallucination
 * via prompt + JSON schema validation. Returns empty books[] when LLM is uncertain.
 *
 * Phase F.2 (2026-05-18) — accepts optional `crystallizedTags` from goal-crystallizer.
 * When present, switches to FIT-OVER-POPULAR prompt that demands per-book
 * personal_fit_score + popularity_score + tradeoff_note when they diverge.
 * niche_factor=high forces ≥ 1 cold pick. Backward-compat: callers without
 * crystallizedTags get the original canonical-mode prompt unchanged.
 *
 * @param {{goal: string, archetype?: string, crystallizedTags?: object, settings?: object, options?: object}} args
 * @returns {Promise<{books: Array, confidence: number, notes: string, mode: string, _meta: object}>}
 */
async function recommendBooks({ goal, archetype, crystallizedTags, settings, options = {} } = {}) {
  if (!goal || typeof goal !== 'string' || !goal.trim()) {
    return { books: [], confidence: 0, notes: 'goal required', mode: 'none', _meta: { error: 'no-goal' } };
  }

  const arch = (archetype && typeof archetype === 'string') ? archetype.trim() : 'TECH-CONCEPT';
  const hint = ARCHETYPE_SOURCE_HINT[arch] || ARCHETYPE_SOURCE_HINT['TECH-CONCEPT'];

  // Mode select: fit-over-popular when crystallizedTags present + has primary_focus
  // (the most discriminating tag). Else fall back to canonical mode.
  const useFitMode = !!(crystallizedTags && typeof crystallizedTags === 'object'
    && typeof crystallizedTags.primary_focus === 'string'
    && crystallizedTags.primary_focus.trim());
  const systemPrompt = useFitMode ? RECOMMEND_FIT_OVER_POPULAR_PROMPT : RECOMMEND_SYSTEM_PROMPT;

  const tagsBlock = useFitMode ? `

CRYSTALLIZED TAGS (drive your fit assessment):
  primary_focus: ${crystallizedTags.primary_focus}
  output_form: ${crystallizedTags.output_form || '(unspecified)'}
  current_level: ${crystallizedTags.current_level || '(unspecified)'}
  timeline: ${crystallizedTags.timeline || '(unspecified)'}
  niche_factor: ${crystallizedTags.niche_factor || 'med'}
  scale: ${crystallizedTags.scale || '(unspecified)'}` : '';

  const userMsg = `LEARNING GOAL:
${goal.trim()}

ARCHETYPE: ${arch}
ARCHETYPE SOURCING HINT: ${hint}${tagsBlock}

Generate book recommendations as STRICT JSON per the SCHEMA.`;

  const capability = options.capability || 'T3_MID';
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 1400;
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.35;

  try {
    const { executeChat } = require('../llm');
    const t0 = Date.now();
    const dispatch = await executeChat(capability, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      json: true,
      maxTokens,
      temperature,
      timeoutMs: 45_000,
    });
    const ms = Date.now() - t0;

    const result = dispatch && dispatch.result;
    const validation = validateRecommendation(result);
    if (!validation.ok) {
      return {
        books: [],
        confidence: 0,
        notes: `recommendation validation failed: ${validation.error}`,
        mode: useFitMode ? 'fit-over-popular' : 'canonical',
        _meta: {
          ms,
          provider: dispatch && dispatch.providerId,
          model: dispatch && dispatch.model,
          validation_error: validation.error,
          raw_result_keys: result && typeof result === 'object' ? Object.keys(result) : null,
        },
      };
    }

    // Cap books, clamp confidence, sanitize each field defensively.
    const books = (Array.isArray(result.books) ? result.books : [])
      .slice(0, RECOMMEND_MAX_BOOKS)
      .map(_sanitizeBookEntry)
      .filter(Boolean);
    const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
    const notes = typeof result.notes === 'string' ? result.notes.slice(0, 200) : '';

    return {
      books,
      confidence,
      notes,
      mode: useFitMode ? 'fit-over-popular' : 'canonical',
      _meta: {
        ms,
        provider: dispatch && dispatch.providerId,
        model: dispatch && dispatch.model,
        capability,
        archetype: arch,
        niche_factor: useFitMode ? (crystallizedTags.niche_factor || 'med') : null,
      },
    };
  } catch (err) {
    return {
      books: [],
      confidence: 0,
      notes: `LLM call failed: ${(err && err.message) || String(err)}`,
      mode: useFitMode ? 'fit-over-popular' : 'canonical',
      _meta: { error: 'llm-failure' },
    };
  }
}

function validateRecommendation(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'not an object' };
  if (!Array.isArray(result.books)) return { ok: false, error: 'books field missing or not array' };
  // Empty books with explicit confidence is valid (LLM saying "I don't know")
  if (result.books.length === 0) return { ok: true };
  for (let i = 0; i < result.books.length; i++) {
    const b = result.books[i];
    if (!b || typeof b !== 'object') return { ok: false, error: `books[${i}]: not object` };
    if (typeof b.title !== 'string' || !b.title.trim()) return { ok: false, error: `books[${i}].title required` };
    if (typeof b.author !== 'string' || !b.author.trim()) return { ok: false, error: `books[${i}].author required` };
    if (typeof b.language !== 'string') return { ok: false, error: `books[${i}].language required` };
    if (typeof b.why_canonical !== 'string') return { ok: false, error: `books[${i}].why_canonical required` };
    // scores are normalised in _sanitizeBookEntry — validator only requires title/author/language/why
  }
  return { ok: true };
}

function _sanitizeBookEntry(b) {
  if (!b || typeof b !== 'object') return null;
  const title = String(b.title || '').trim().slice(0, 200);
  if (!title) return null;
  const author = String(b.author || '').trim().slice(0, 120);
  if (!author) return null;
  const out = {
    title,
    author,
    language: String(b.language || 'unknown').trim().slice(0, 8),
    why_canonical: String(b.why_canonical || '').trim().slice(0, 200),
    category: (b.category === 'primary' || b.category === 'secondary') ? b.category : 'secondary',
    suggested_format: ['PDF', 'EPUB', 'MD', 'HTML', 'DOCX'].includes(b.suggested_format) ? b.suggested_format : 'PDF',
  };
  if (typeof b.title_pinyin_or_romaji === 'string' && b.title_pinyin_or_romaji.trim()) {
    out.title_pinyin_or_romaji = b.title_pinyin_or_romaji.trim().slice(0, 200);
  }
  if (Number.isInteger(b.year) && b.year > 0 && b.year < 3000) {
    out.year = b.year;
  }
  // Phase F.2 + G.0 — fit-mode scores now REQUIRED across both modes (2026-05-18
  // user lock). When LLM omits, pad to 0.5 ("mid-fit") so the UI RatingBar
  // always has something to render — beats showing nothing or a blank card.
  out.personal_fit_score = Number.isFinite(b.personal_fit_score)
    ? Math.max(0, Math.min(1, Number(b.personal_fit_score)))
    : 0.5;
  out.popularity_score = Number.isFinite(b.popularity_score)
    ? Math.max(0, Math.min(1, Number(b.popularity_score)))
    : 0.5;
  if (typeof b.tradeoff_note === 'string' && b.tradeoff_note.trim()) {
    out.tradeoff_note = b.tradeoff_note.trim().slice(0, 200);
  }
  return out;
}

module.exports = {
  assessCoverage,
  recommendBooks,
  validateRecommendation,
  _internals: {
    COVERAGE_MIN_DISTINCT_BOOKS,
    COVERAGE_MIN_HITS,
    COVERAGE_GRAPH_K,
    RECOMMEND_MAX_BOOKS,
    RECOMMEND_MIN_BOOKS,
    ARCHETYPE_SOURCE_HINT,
    _sanitizeBookEntry,
  },
};
