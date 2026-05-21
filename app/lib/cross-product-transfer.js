'use strict';

// HYPHA · Cross-Product Transfer (BLUEPRINT §11.3).
//
// 2026-05-13 — Per §11.3: 每次 Deepen / Lesson / Note 处理时, 系统跨**所有** active
// products 扫描相关性, 在 lesson body 追加 "迁移到 [产品名]" 段。这是把
// product-transfer.js (W3.3, per-slug-bound) 升级成 vault-level cross-product
// loop — 与 product-registry.js 配套, 替代 "产品和课程强绑" 的旧实现。
//
// API:
//   scanInsight({ insightText, sourceRef, lessonContext?, threshold? })
//     → { hits: [{productId, productName, P, suggestion, sectionId}],
//         best?: {...hits[0]},
//         scanned: <int> }
//   appendBestToInspirationPool(scanResult)
//     → { ok, appendedTo: productId } | { ok:true, appendedTo: null } if best.P<threshold
//
// scanInsight is PURE (no fs write). appendBestToInspirationPool is the
// side-effecting follow-up the caller chooses to commit (or skip if user
// dismissed).
//
// LLM-free for now — Jaccard token overlap against each product's blueprint
// (consistent with product-transfer.js cheap stage). T4_JUDGE LLM refinement
// can be plugged in later via _refineHit hook (see comment below).

const productRegistry = require('./product-registry');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_THRESHOLD = 0.08;  // jaccard threshold for "worth surfacing".
                                  // Tuned much lower than W3.3's 0.6 because:
                                  //   (a) cross-product *ranking* picks best,
                                  //       not gating — user sees hit list;
                                  //   (b) hint is dismissible, not callout;
                                  //   (c) empirical: realistic ZH+EN insights
                                  //       hit 0.08-0.15 against tight blueprints.

const _TOKEN_SPLIT_RX = /[\s,.;:!?'"`()\[\]{}<>/\\|*+=#&%$@~^—–\-_…，。；：！？、《》「」『』（）【】]+/u;
const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'are', 'was', 'has', 'how', 'why', 'what',
  '的', '是', '和', '在', '了', '与', '一个', '一种',
]);

function _tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const raw = String(text).toLowerCase().trim();
  if (!raw) return [];
  const out = [];
  raw.split(_TOKEN_SPLIT_RX).forEach((tok) => {
    if (!tok) return;
    if (/^[a-z0-9][a-z0-9_]*$/.test(tok)) {
      if (tok.length >= 2) out.push(tok);
      return;
    }
    let buf = '';
    for (const ch of tok) {
      const isCJK = /[　-〿一-鿿぀-ヿ가-힯]/.test(ch);
      if (isCJK) {
        if (buf.length >= 2) out.push(buf);
        buf = '';
        out.push(ch);
      } else if (/[a-z0-9]/i.test(ch)) {
        buf += ch.toLowerCase();
      } else if (buf) {
        if (buf.length >= 2) out.push(buf);
        buf = '';
      }
    }
    if (buf.length >= 2) out.push(buf);
  });
  return out.filter(t => !STOP.has(t));
}

function _jaccard(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let inter = 0;
  aSet.forEach(t => { if (bSet.has(t)) inter += 1; });
  const union = aSet.size + bSet.size - inter;
  return union <= 0 ? 0 : inter / union;
}

// Parse blueprint.md section bodies — light-weight, header-driven. Section
// IDs come from `<!-- section-id: X -->` markers (set by product-registry's
// renderer). Returns { northStar: "...", modules: "...", ... } keyed by id.
function _parseBlueprintSections(md) {
  if (!md || typeof md !== 'string') return {};
  const out = {};
  // Match each `<!-- section-id: X -->` and capture content until the next
  // `## ` header or end of doc.
  const re = /<!--\s*section-id:\s*([a-zA-Z_]+)\s*-->\s*([\s\S]*?)(?=\n##\s|$)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

// Pick the section with highest jaccard against the insight — proposed
// target for "this goes into <section>" hint.
function _pickBestSection(insightTokens, sectionMap) {
  let best = { sectionId: 'inspirationPool', score: 0 };
  for (const [sid, body] of Object.entries(sectionMap)) {
    if (!body) continue;
    const t = _tokenize(body);
    const j = _jaccard(insightTokens, t);
    if (j > best.score) best = { sectionId: sid, score: j };
  }
  return best;
}

// Generate a short suggestion line — markdown-friendly. Plug LLM refinement
// here later (T4_JUDGE 200-400 字 markdown body); MVP returns a template.
function _renderSuggestion({ productName, insightText, sectionId }) {
  const sectionLabel = ({
    northStar:       '北极星',
    targetUsers:     '目标用户',
    corePain:        '核心痛点',
    hypothesis:      '当前假设',
    modules:         '模块',
    openQuestions:   'Open Questions',
    inspirationPool: '灵感池',
    decisionLog:     'Decision Log',
    riskMap:         '风险图',
    roadmap:         '路线图',
  })[sectionId] || sectionId;
  const snippet = String(insightText || '').replace(/\s+/g, ' ').slice(0, 120);
  return `**迁移到 ${productName}** (建议 → ${sectionLabel}): 这一段是否能修改 ${productName} 的${sectionLabel}? — ${snippet}${snippet.length >= 120 ? '…' : ''}`;
}

/**
 * Scan all vault-level products and rank by relevance to the given insight.
 *
 * @param {{ insightText: string, sourceRef?: string, lessonContext?: object, threshold?: number }} args
 * @returns {{ hits: object[], best?: object, scanned: number }}
 */
function scanInsight({ insightText, sourceRef, lessonContext, threshold } = {}) {
  if (!insightText || typeof insightText !== 'string') {
    return { hits: [], scanned: 0 };
  }
  const products = productRegistry.listProducts();
  if (!products.length) return { hits: [], scanned: 0 };
  const insightTokens = _tokenize(
    [insightText, lessonContext && lessonContext.lessonTitle, lessonContext && lessonContext.learnGoal]
      .filter(Boolean).join(' ')
  );
  const T = typeof threshold === 'number' ? threshold : DEFAULT_THRESHOLD;
  const hits = [];
  for (const meta of products) {
    const full = productRegistry.getProduct(meta.productId);
    if (!full || !full.blueprintMd) continue;
    const sectionMap = _parseBlueprintSections(full.blueprintMd);
    // Aggregate tokens across blueprint + product meta name + north star.
    const productTokens = _tokenize(
      [
        full.name, full.northStar,
        ...Object.values(sectionMap),
      ].filter(Boolean).join(' ')
    );
    const P = _jaccard(insightTokens, productTokens);
    if (P < T) continue;
    const bestSection = _pickBestSection(insightTokens, sectionMap);
    hits.push({
      productId: meta.productId,
      productName: meta.name,
      productType: meta.type,
      P: Number(P.toFixed(4)),
      sectionId: bestSection.sectionId,
      sectionScore: Number(bestSection.score.toFixed(4)),
      suggestion: _renderSuggestion({
        productName: meta.name,
        insightText,
        sectionId: bestSection.sectionId,
      }),
      sourceRef: sourceRef || null,
    });
  }
  hits.sort((a, b) => b.P - a.P);
  const best = hits[0] || null;
  return { hits, best, scanned: products.length };
}

/**
 * Append the highest-relevance hit to that product's inspiration-pool.jsonl.
 * Caller decides whether to commit (typically after user accepts the surface).
 *
 * @param {{ best: object, sourceRef?: string }} scanResult
 * @returns {{ ok: boolean, appendedTo?: string, error?: string }}
 */
function appendBestToInspirationPool(scanResult) {
  if (!scanResult || !scanResult.best) {
    return { ok: true, appendedTo: null };
  }
  const { productId, P, sectionId, sourceRef, suggestion } = scanResult.best;
  const row = {
    source: sourceRef || 'unknown',
    relevance: P,
    source_summary: suggestion,
    linked_section_id: sectionId,
  };
  const r = productRegistry.appendInspiration(productId, row);
  if (!r || !r.ok) return { ok: false, error: r && r.error };
  return { ok: true, appendedTo: productId };
}

module.exports = {
  DEFAULT_THRESHOLD,
  scanInsight,
  appendBestToInspirationPool,
};
