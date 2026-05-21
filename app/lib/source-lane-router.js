'use strict';

// HYPHA · source-lane-router — 5-layer × 6-archetype source routing.
//
// Per `project_hypha_5layer_scrape_spec` (memory 2026-05-09): harvest is
// demand-driven, not blast. Given an archetype + query + optional topic
// taxonomy, produce an ORDERED plan that says which of the 5 source layers
// to hit, in what priority, via which transport (webfetch / bb-browser / skip).
//
// LAYERS (per spec):
//   1. canonical   — textbooks / primary sources (MIT OCW / Stanford / OpenStax)
//   2. pedagogy    — syllabi / lecture notes / course pages (Eberly / Bok)
//   3. frontier    — conferences / arXiv / OpenReview / best-papers
//   4. engineering — GitHub READMEs / framework docs / lab blogs
//   5. user        — local notes / sparks / threads (vault)
//
// ROUTES:
//   'webfetch'   — public HTTP, no auth (default)
//   'bb-browser' — CDP daemon w/ site adapters (twitter / reddit / producthunt
//                  / xiaohongshu / appstore). 知乎 OUT (user lock 2026-05-09).
//   'skip'       — layer not applicable for this archetype
//
// This module is DECISION-ONLY: it does NOT invoke bb-browser, fetch URLs, or
// touch the vault. It returns a plan; downstream code (harvest pipeline) acts
// on it. Pairs with archetype-lanes.js (per-archetype priority_sources kit)
// which feeds the `sources` array per layer.
//
// Per coding-style.md: immutable returns (Object.freeze on plan + layers),
// pure function (no side effects), no console.log.

const { ARCHETYPE_LANES, getPrioritySourcesFor } = require('./harvest/archetype-lanes');

// ───────────────────────────────────────────────────────────────────────────
// Routing matrix: archetype → { layer → { priority, route, reason } }
//
// Priority 1 = highest; layers with priority null = `skip`.
// Drawn from spec table + per-archetype register_hint in archetype-lanes.js.
// ───────────────────────────────────────────────────────────────────────────
const ROUTING_MATRIX = Object.freeze({
  'HUMANITIES': Object.freeze({
    canonical:   { priority: 1, route: 'webfetch',   reason: '经典原文 + 顶级评论 = 人文核心 (gutenberg / oxford / nybr)' },
    pedagogy:    { priority: 2, route: 'webfetch',   reason: '文学批评教学法 (Bok Center / Yale OYC literature)' },
    frontier:    { priority: 5, route: 'skip',       reason: '人文 archetype 跳过 arXiv frontier — register conflict' },
    engineering: { priority: 5, route: 'skip',       reason: '人文 archetype 跳过 GitHub / framework docs — irrelevant' },
    user:        { priority: 3, route: 'webfetch',   reason: '本地 vault notes + sparks (transport stub: local)' },
  }),
  'TECH-CONCEPT': Object.freeze({
    canonical:   { priority: 4, route: 'webfetch',   reason: '光课程教材 light touch — frontier 才是 anchor' },
    pedagogy:    { priority: 5, route: 'skip',       reason: 'TECH-CONCEPT 不抓 pedagogy 设计 — 重 paper / blog' },
    frontier:    { priority: 1, route: 'webfetch',   reason: 'arXiv / Anthropic / OpenAI / DeepMind / Distill = 主战场' },
    engineering: { priority: 2, route: 'bb-browser', reason: 'Karpathy / Simon Willison Twitter + r/MachineLearning 讨论' },
    user:        { priority: 3, route: 'webfetch',   reason: '本地 vault notes + sparks (transport stub: local)' },
  }),
  'TECH-PROC': Object.freeze({
    canonical:   { priority: 5, route: 'skip',       reason: 'TECH-PROC 不要教材 — 要 working example' },
    pedagogy:    { priority: 5, route: 'skip',       reason: 'TECH-PROC 不要教学法 — 要 cookbook' },
    frontier:    { priority: 4, route: 'webfetch',   reason: 'frontier light — 偶尔 paper 验 API 变化' },
    engineering: { priority: 1, route: 'bb-browser', reason: '官方 docs + GitHub trending + r/programming + ProductHunt' },
    user:        { priority: 2, route: 'webfetch',   reason: '本地 vault notes + sparks (transport stub: local)' },
  }),
  'LANG-ACQ': Object.freeze({
    canonical:   { priority: 1, route: 'webfetch',   reason: '语料库 (COCA / BNC) + native podcast = 母语 input anchor' },
    pedagogy:    { priority: 2, route: 'webfetch',   reason: '二语习得理论 (Krashen / Ellis) = pedagogy 重要' },
    frontier:    { priority: 5, route: 'skip',       reason: 'LANG-ACQ 跳 frontier — 语言习得不是 arXiv 战场' },
    engineering: { priority: 4, route: 'webfetch',   reason: '极轻 — 偶尔需要 transcript tool / Anki deck' },
    user:        { priority: 3, route: 'webfetch',   reason: '本地 vault notes + 用户母语对照 (transport stub: local)' },
  }),
  'DECL-MASS': Object.freeze({
    canonical:   { priority: 1, route: 'webfetch',   reason: '官方教材 + 真题 = 考纲 anchor (DECL-MASS 核心)' },
    pedagogy:    { priority: 3, route: 'webfetch',   reason: '考试题型分析 + 解题套路 = pedagogy 中等' },
    frontier:    { priority: 5, route: 'skip',       reason: 'DECL-MASS 跳 frontier — 考纲外不学' },
    engineering: { priority: 5, route: 'skip',       reason: 'DECL-MASS 跳 engineering — irrelevant' },
    user:        { priority: 2, route: 'webfetch',   reason: '本地题库 + 错题本 (transport stub: local)' },
  }),
  'MINDSET': Object.freeze({
    canonical:   { priority: 2, route: 'webfetch',   reason: 'Munger / Buffett 级 corpus + Poor Charlie 经典' },
    pedagogy:    { priority: 4, route: 'webfetch',   reason: 'rationalist sequences 教学法 = 中等' },
    frontier:    { priority: 5, route: 'skip',       reason: 'MINDSET 跳 frontier — 不抓 hype thread' },
    engineering: { priority: 3, route: 'bb-browser', reason: 'LessWrong + Farnam Street + 顶级 podcast 讨论' },
    user:        { priority: 1, route: 'webfetch',   reason: '本地 vault notes + sparks = 心智模式个性化锚 (highest)' },
  }),
});

// URL patterns that ALWAYS route bb-browser regardless of layer assignment.
// 知乎 explicitly excluded per user lock 2026-05-09 (feedback_scraping_via_bb_browser).
const BB_BROWSER_HOST_PATTERNS = Object.freeze([
  /(?:^|\.)twitter\.com$/i,
  /(?:^|\.)x\.com$/i,
  /(?:^|\.)reddit\.com$/i,
  /(?:^|\.)producthunt\.com$/i,
  /(?:^|\.)xiaohongshu\.com$/i,
  /(?:^|\.)apps\.apple\.com$/i,
  /(?:^|\.)itunes\.apple\.com$/i,
]);

const BB_BROWSER_BLOCKED_HOSTS = Object.freeze([
  /(?:^|\.)zhihu\.com$/i, // 知乎 OUT 2026-05-09
]);

function _hostnameOf(url) {
  if (typeof url !== 'string') return '';
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

/**
 * Decide transport for a single source URL.
 * @param {string} url
 * @returns {{route: 'bb-browser'|'webfetch'|'skip', reason: string}}
 */
function decideTransportForUrl(url) {
  const host = _hostnameOf(url);
  if (!host) return Object.freeze({ route: 'webfetch', reason: 'no-host (treat as webfetch)' });
  for (const re of BB_BROWSER_BLOCKED_HOSTS) {
    if (re.test(host)) {
      return Object.freeze({
        route: 'skip',
        reason: `host ${host} blocked (user lock 2026-05-09: 知乎 OUT)`,
      });
    }
  }
  for (const re of BB_BROWSER_HOST_PATTERNS) {
    if (re.test(host)) {
      return Object.freeze({
        route: 'bb-browser',
        reason: `host ${host} = login-walled / community-discussion → bb-browser CDP`,
      });
    }
  }
  return Object.freeze({ route: 'webfetch', reason: `host ${host} = public HTTP → webfetch` });
}

function _isValidArchetype(a) {
  return typeof a === 'string' && Object.prototype.hasOwnProperty.call(ROUTING_MATRIX, a);
}

function _topicFromQuery(query, topicTaxonomy) {
  if (typeof query === 'string' && query.trim()) return query.trim();
  if (topicTaxonomy && typeof topicTaxonomy.topic === 'string') return topicTaxonomy.topic.trim();
  return '';
}

/**
 * routeLanes — return an ordered plan of 5 source layers for given archetype.
 *
 * @param {object}   params
 * @param {string}   params.archetype       e.g. 'HUMANITIES' / 'TECH-CONCEPT'
 * @param {string}   [params.query]         topic / search query
 * @param {object}   [params.topic_taxonomy] optional richer topic context
 * @returns {{
 *   ok: boolean,
 *   archetype: string,
 *   query: string,
 *   plan: Array<{
 *     layer: 'canonical'|'pedagogy'|'frontier'|'engineering'|'user',
 *     priority: number,
 *     route: 'webfetch'|'bb-browser'|'skip',
 *     reason: string,
 *     sources: Array<{id: string, url: string, notes: string, route: string, route_reason: string}>
 *   }>,
 *   skipped_layers: Array<string>,
 *   reason?: string
 * }}
 */
function routeLanes(params) {
  const p = params || {};
  if (!_isValidArchetype(p.archetype)) {
    return Object.freeze({
      ok: false,
      archetype: String(p.archetype || ''),
      query: '',
      plan: Object.freeze([]),
      skipped_layers: Object.freeze([]),
      reason: `unknown archetype "${p.archetype}" — must be one of ${Object.keys(ROUTING_MATRIX).join(' / ')}`,
    });
  }
  const archetype = p.archetype;
  const query = _topicFromQuery(p.query, p.topic_taxonomy);
  const matrix = ROUTING_MATRIX[archetype];

  // archetype-lanes.js carries the priority_sources kit for canonical /
  // pedagogy / frontier / engineering. We fold that kit into the right layer
  // based on the source id prefix. For now, all priority_sources land in
  // their archetype's HIGHEST-priority non-skipped layer (i.e. the lane's
  // anchor layer). Per-source URL transport decision is also computed.
  const laneSources = getPrioritySourcesFor(archetype, query);

  // Map: which layer gets the archetype-lanes.js sources? Convention: drop
  // them in the lowest-priority-number (= most important) layer that is NOT
  // skipped, since archetype-lanes.js is itself archetype-anchor.
  let anchorLayer = null;
  let anchorPri = Infinity;
  for (const layer of ['canonical', 'pedagogy', 'frontier', 'engineering', 'user']) {
    const cell = matrix[layer];
    if (cell.route === 'skip') continue;
    if (cell.priority < anchorPri) {
      anchorPri = cell.priority;
      anchorLayer = layer;
    }
  }

  const skipped = [];
  const plan = [];
  for (const layer of ['canonical', 'pedagogy', 'frontier', 'engineering', 'user']) {
    const cell = matrix[layer];
    if (cell.route === 'skip') {
      skipped.push(layer);
      plan.push(Object.freeze({
        layer,
        priority: cell.priority,
        route: 'skip',
        reason: cell.reason,
        sources: Object.freeze([]),
      }));
      continue;
    }
    const sources = (layer === anchorLayer ? laneSources : []).map((s) => {
      const t = decideTransportForUrl(s.url);
      return Object.freeze({
        id: s.id,
        url: s.url,
        notes: s.notes,
        route: t.route,
        route_reason: t.reason,
      });
    });
    plan.push(Object.freeze({
      layer,
      priority: cell.priority,
      route: cell.route,
      reason: cell.reason,
      sources: Object.freeze(sources),
    }));
  }

  // Sort by priority ascending so caller iterates highest-priority-first.
  plan.sort((a, b) => a.priority - b.priority);

  return Object.freeze({
    ok: true,
    archetype,
    query,
    plan: Object.freeze(plan),
    skipped_layers: Object.freeze(skipped),
  });
}

/**
 * listArchetypes — for picker UI + validation.
 * @returns {Array<string>}
 */
function listSupportedArchetypes() {
  return Object.keys(ROUTING_MATRIX);
}

/**
 * laneCellFor — get the raw routing cell for an archetype + layer.
 * @param {string} archetype
 * @param {string} layer
 * @returns {{priority: number, route: string, reason: string} | null}
 */
function laneCellFor(archetype, layer) {
  if (!_isValidArchetype(archetype)) return null;
  const cell = ROUTING_MATRIX[archetype][layer];
  return cell || null;
}

module.exports = Object.freeze({
  routeLanes,
  decideTransportForUrl,
  listSupportedArchetypes,
  laneCellFor,
  ROUTING_MATRIX,
  BB_BROWSER_HOST_PATTERNS,
  BB_BROWSER_BLOCKED_HOSTS,
  LAYERS: Object.freeze(['canonical', 'pedagogy', 'frontier', 'engineering', 'user']),
});
