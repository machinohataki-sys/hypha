'use strict';
//
// HYPHA · hypha-scout — LLM-driven multi-round frontier scout
// ============================================================
//
// PURPOSE
// -------
// Existing harvest channels use HARDCODED query templates (`topic + " intro"`,
// `topic + " syllabus"`, etc.). That tilts every course toward training-
// frequency bias: famous canonical sources dominate, frontier 2024-2026 work
// gets missed, counterargument never surfaces, engineering / pedagogy lanes
// stay shallow. Galileo-opener bug (v0.2.1) was one symptom; AMD-MEOW Scout
// gap (2026-04-28) named the disease.
//
// This module is HYPHA's NATIVE scout — it does NOT depend on Victor's
// `.claude/skills/scout` (Claude Code agent), and does NOT share state with
// it. It uses HYPHA's own LLM router (T6_STRONG to plan queries, T4_JUDGE to
// assess coverage), executes Tavily searches in parallel, and iterates up to
// 3 rounds until 6 dimensions all have >= 2 sources OR round budget exhausts.
//
// 6 dimensions enforced per query-plan prompt:
//   1) canonical      — 经典 / 教材 / 综述
//   2) frontier       — 前沿论文 / 2024-2026 paper / arxiv
//   3) counterargument — 反方 / 失败案例 / 局限性 / critique
//   4) engineering    — 实现 / 工程范例 / 开源仓库 / github
//   5) cross-domain   — 类比 / 跨学科启发
//   6) pedagogy       — 好的入门讲解 / 视频 / blog / Karpathy-tier 解释
//
// USAGE (留给主调度接, 此文件 NOT 接 IPC — 留给下一 Machino 桥):
//   const { scoutFrontier } = require('./harvest/hypha-scout');
//   const result = await scoutFrontier({
//     northStar:    goalContract.north_star_goal,
//     mainCreation: goalContract.main_creation,
//     archetype:    goalContract.archetype,
//     settings,
//     onProgress:   (stage, payload) => emit(stage, payload),  // BuildLog bridge
//   });
//   // result.sources → 合并入既有 harvest 结果 (待主调度合并)
//   // result.meta    → { rounds, dimensions, coverage } for BuildLog
//
// CONTRACT
// --------
// async scoutFrontier({ northStar, mainCreation, archetype, settings, onProgress })
//   → { sources: Source[], meta: ScoutMeta }
//
// Source = {
//   title:        string,
//   url:          string,
//   snippet:      string,
//   layer:        'frontier-scout',
//   query_origin: string,
//   dimension:    DimensionKey,
// }
// ScoutMeta = { rounds, dimensions, coverage }
//
// FAIL MODE
// ---------
// No TAVILY_API_KEY → emit 'scout:tavily-skipped'; fallback to Wikipedia
// opensearch + arxiv Atom feed. Coverage assessment + refinement still run.
//
// DEPS — app/lib/llm (executeChat), app/lib/harvest/hypha-scout-llm (sister).
//

const llm = require('./hypha-scout-llm');
const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

const { DIMENSIONS, ESTIMATE_DIMENSIONS, TARGET_PER_DIM, planQueries, assessCoverage } = llm;

const MAX_ROUNDS = 3;
const MAX_PARALLEL_QUERIES = 6;
const MAX_RESULTS_PER_QUERY = 8;
const TAVILY_TIMEOUT_MS = 8000;

// ──────────────────────────────────────────────────────────────────────────
// Public entry
// ──────────────────────────────────────────────────────────────────────────

async function scoutFrontier({
  northStar,
  mainCreation,
  archetype,
  settings,
  onProgress,
  mode,
} = {}) {
  const emit = typeof onProgress === 'function' ? onProgress : (() => {});
  const tavilyKey = (settings && settings.tavilyKey) || process.env.TAVILY_API_KEY || '';
  const archetypeLabel = _archetypeLabel(archetype);
  const planMode = mode === 'estimate' ? 'estimate' : 'standard';

  emit('scout:start', { northStar, archetype: archetypeLabel, mode: planMode });

  const seenUrls = new Set();
  const collected = [];
  const activeDims = planMode === 'estimate' ? ESTIMATE_DIMENSIONS : DIMENSIONS;
  let coverage = _emptyCoverage(activeDims);
  let round = 0;

  // ── Round 1: generate 8-12 diverse queries, 6-dim balanced ──
  // estimate mode adds 7th case-trajectory dim → 11-17 queries.
  round = 1;
  const round1Queries = await planQueries({
    round,
    northStar,
    mainCreation,
    archetypeLabel,
    knownCoverage: null,
    knownGaps:     null,
    emit,
    mode: planMode,
  });

  const round1Sources = await _runSearchRound({
    round,
    queries: round1Queries,
    tavilyKey,
    seenUrls,
    emit,
  });
  collected.push(...round1Sources);
  coverage = _recomputeCoverage(collected, activeDims);
  emit('scout:search-round-done', {
    round,
    sourceCount: collected.length,
    byDimension: { ...coverage },
  });

  // ── Round 2: assess + refine ──
  const round2Decision = await _decideRefine({
    round: 2,
    northStar,
    archetypeLabel,
    collected,
    coverage,
    emit,
    activeDims,
  });

  if (round2Decision.willRefine && round2Decision.extraQueries.length > 0) {
    round = 2;
    const more = await _runSearchRound({
      round,
      queries: round2Decision.extraQueries,
      tavilyKey,
      seenUrls,
      emit,
    });
    collected.push(...more);
    coverage = _recomputeCoverage(collected, activeDims);
    emit('scout:search-round-done', {
      round,
      sourceCount: collected.length,
      byDimension: { ...coverage },
    });

    // ── Round 3 (optional, only if still under-covered) ──
    if (_dimensionsBelow(coverage, TARGET_PER_DIM, activeDims).length > 0 && MAX_ROUNDS >= 3) {
      const round3Decision = await _decideRefine({
        round: 3,
        northStar,
        archetypeLabel,
        collected,
        coverage,
        emit,
        activeDims,
      });
      if (round3Decision.willRefine && round3Decision.extraQueries.length > 0) {
        round = 3;
        const final = await _runSearchRound({
          round,
          queries: round3Decision.extraQueries,
          tavilyKey,
          seenUrls,
          emit,
        });
        collected.push(...final);
        coverage = _recomputeCoverage(collected, activeDims);
        emit('scout:search-round-done', {
          round,
          sourceCount: collected.length,
          byDimension: { ...coverage },
        });
      }
    }
  }

  emit('scout:done', {
    totalSources: collected.length,
    rounds:       round,
    byDimension:  { ...coverage },
    coverage:     { ...coverage },
    mode:         planMode,
  });

  return {
    sources: collected,
    meta: {
      rounds:     round,
      dimensions: [...activeDims],
      coverage:   { ...coverage },
      mode:       planMode,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Round refinement decision
// ──────────────────────────────────────────────────────────────────────────

async function _decideRefine({ round, northStar, archetypeLabel, collected, coverage, emit, activeDims }) {
  const { parsedExtraQueries, parsedGaps } = await assessCoverage({
    round,
    northStar,
    archetypeLabel,
    collected,
    emit,
  });
  const dims = activeDims || DIMENSIONS;
  const trueCoverage = _recomputeCoverage(collected, dims);
  const thinDims = _dimensionsBelow(trueCoverage, TARGET_PER_DIM, dims);
  const gaps = (parsedGaps && parsedGaps.length) ? parsedGaps : thinDims.map(d => `${d} 不足`);
  const willRefine = thinDims.length > 0 && parsedExtraQueries.length > 0;
  emit('scout:coverage-assessed', {
    coverage: { ...trueCoverage },
    gaps,
    willRefine,
  });
  return { willRefine, extraQueries: parsedExtraQueries };
}

// ──────────────────────────────────────────────────────────────────────────
// Search execution  (Tavily preferred, Wikipedia+arxiv fallback)
// ──────────────────────────────────────────────────────────────────────────

async function _runSearchRound({ round, queries, tavilyKey, seenUrls, emit }) {
  if (!queries || queries.length === 0) return [];
  const out = [];
  for (let i = 0; i < queries.length; i += MAX_PARALLEL_QUERIES) {
    const chunk = queries.slice(i, i + MAX_PARALLEL_QUERIES);
    const settled = await Promise.allSettled(
      chunk.map(q => _runOneQuery({ round, q, tavilyKey, emit })),
    );
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
      for (const src of r.value) {
        if (!src || !src.url || seenUrls.has(src.url)) continue;
        seenUrls.add(src.url);
        out.push(src);
      }
    }
  }
  return out;
}

async function _runOneQuery({ round, q, tavilyKey, emit }) {
  if (tavilyKey) return _tavilySearch({ q, tavilyKey });
  if (round === 1) emit('scout:tavily-skipped', { reason: 'TAVILY_API_KEY absent' });
  return _fallbackSearch({ q });
}

async function _tavilySearch({ q, tavilyKey }) {
  try {
    const res = await _withTimeout(fetchFn('https://api.tavily.com/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:             tavilyKey,
        query:               q.query,
        search_depth:        'basic',
        max_results:         MAX_RESULTS_PER_QUERY,
        include_answer:      false,
        include_raw_content: false,
      }),
    }), TAVILY_TIMEOUT_MS);
    if (!res || !res.ok) return [];
    const json = await res.json();
    const results = Array.isArray(json && json.results) ? json.results : [];
    return results
      .map(r => _normalizeSource({
        title:        r.title,
        url:          r.url,
        snippet:      r.content,
        dimension:    q.dimension,
        query_origin: q.query,
      }))
      .filter(Boolean);
  } catch (_) { return []; }
}

async function _fallbackSearch({ q }) {
  const out = [];
  const dim = q.dimension;
  const wantArxiv = (dim === 'frontier' || dim === 'counterargument' || dim === 'engineering');
  const wantWiki  = (dim === 'canonical' || dim === 'pedagogy' || dim === 'cross-domain' || dim === 'counterargument');
  if (wantArxiv) {
    const a = await _arxivSearch(q.query);
    for (const s of a) out.push(_normalizeSource({ ...s, dimension: dim, query_origin: q.query }));
  }
  if (wantWiki) {
    const w = await _wikipediaSearch(q.query);
    for (const s of w) out.push(_normalizeSource({ ...s, dimension: dim, query_origin: q.query }));
  }
  return out.filter(Boolean);
}

async function _arxivSearch(query) {
  try {
    const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=5&sortBy=submittedDate&sortOrder=descending`;
    const res = await _withTimeout(fetchFn(url, { headers: { 'User-Agent': 'Hypha-scout/0.1' } }), TAVILY_TIMEOUT_MS);
    if (!res || !res.ok) return [];
    const xml = await res.text();
    const entries = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = entryRe.exec(xml)) !== null && entries.length < 5) {
      const block = m[1];
      const title   = _xmlTag(block, 'title');
      const id      = _xmlTag(block, 'id');
      const summary = _xmlTag(block, 'summary');
      if (title && id) entries.push({ title, url: id.trim(), snippet: summary });
    }
    return entries;
  } catch (_) { return []; }
}

async function _wikipediaSearch(query) {
  // 2026-05-17 — switched from opensearch (literal prefix match — empty for
  // LLM long queries like "foundations of AI agent textbook") to full-text
  // search (relevance-ranked, handles long descriptive queries). Returns up
  // to 5 hits per call.
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=5&srprop=snippet&format=json&origin=*`;
    const res = await _withTimeout(fetchFn(url, { headers: { 'User-Agent': 'Hypha-scout/0.1' } }), TAVILY_TIMEOUT_MS);
    if (!res || !res.ok) return [];
    const json = await res.json();
    const hits = (json && json.query && Array.isArray(json.query.search)) ? json.query.search : [];
    const out = [];
    for (const h of hits.slice(0, 5)) {
      const title = h && h.title;
      if (!title) continue;
      const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;
      const snippet = String(h.snippet || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      out.push({ title, url: pageUrl, snippet });
    }
    return out;
  } catch (_) { return []; }
}

function _xmlTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = block.match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function _normalizeSource({ title, url, snippet, dimension, query_origin }) {
  const t = String(title || '').trim();
  const u = String(url || '').trim();
  if (!t || !u) return null;
  return {
    title:        t.slice(0, 240),
    url:          u,
    snippet:      String(snippet || '').replace(/\s+/g, ' ').slice(0, 600),
    layer:        'frontier-scout',
    query_origin,
    dimension,
  };
}

function _withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms)),
  ]).catch(() => null);
}

// ──────────────────────────────────────────────────────────────────────────
// Coverage helpers
// ──────────────────────────────────────────────────────────────────────────

function _emptyCoverage(activeDims) {
  const list = Array.isArray(activeDims) && activeDims.length ? activeDims : DIMENSIONS;
  const out = {};
  for (const d of list) out[d] = 0;
  return out;
}

function _recomputeCoverage(collected, activeDims) {
  const cov = _emptyCoverage(activeDims);
  for (const s of collected) {
    if (cov[s.dimension] !== undefined) cov[s.dimension] += 1;
  }
  return cov;
}

function _dimensionsBelow(coverage, threshold, activeDims) {
  const list = Array.isArray(activeDims) && activeDims.length ? activeDims : DIMENSIONS;
  return list.filter(d => (coverage[d] || 0) < threshold);
}

function _archetypeLabel(arch) {
  if (!arch) return '';
  if (typeof arch === 'string') return arch;
  if (typeof arch === 'object') return arch.label || arch.id || '';
  return String(arch);
}

module.exports = {
  scoutFrontier,
  // Exposed for self-test injection only — do NOT depend on these in app code.
  __internals: {
    DIMENSIONS,
    TARGET_PER_DIM,
    MAX_ROUNDS,
    _runSearchRound,
    _runOneQuery,
    _recomputeCoverage,
    _dimensionsBelow,
    _normalizeSource,
    _tavilySearch,
    _fallbackSearch,
  },
};
