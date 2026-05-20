'use strict';

// HYPHA · W6.3 Research Radar — Auto-actions (BLUEPRINT §15)
//
// Three downstream actions fire after a Frontier Report lands. Each one
// is OPT-OUT only (callers choose to invoke), never auto-pushed to UI,
// per the blueprint anti-feed principle:
//
//   1. storeAsNote(slug, report)
//      → writes report markdown as W5.2 web-note-engine layer='raw' node
//      → makes the report findable via existing Notebook / Context Packet
//
//   2. lessonCitationHook(slug, lessonIdx)
//      → reads reports from the last 7 days for this slug
//      → returns a CITATION BLOCK string that designLesson injects into
//        the lesson body system prompt (frontier-aware lesson)
//
//   3. triggerProductSparkCandidate(slug, candidate)
//      → calls W3.4 product-spark.createSpark with state='seed'
//      → source.type='research', source.ref points to the originating report
//
// Boundary discipline:
//   - We DO NOT mutate webnote / product-spark internals. We only call
//     their public surface (addNode / createSpark).
//   - lessonCitationHook is READ-ONLY; designLesson decides whether to
//     inject the returned string.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const radar = require('./radar');
const frontierReport = require('./frontier-report');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// =====================================================================
// 1. storeAsNote — push report into the web-note-engine raw layer
// =====================================================================

/**
 * Store a frontier report as a webnote raw layer node so it appears
 * inside the existing knowledge graph (Notebook surface, Context Packet
 * candidate set, Living Note utility scoring). The node body is the
 * markdown render of the report.
 *
 * @param {string} slug
 * @param {object} report - Frontier Report object (validated)
 * @returns {{ ok:true, node_id:string } | { ok:false, error:string }}
 */
function storeAsNote(slug, report) {
  if (!slug) return { ok: false, error: 'slug required' };
  const v = frontierReport.validateReport(report);
  if (!v.ok) return { ok: false, error: 'report validation failed: ' + v.error };

  let webnote;
  try { webnote = require('../web-note-engine'); }
  catch (err) {
    return { ok: false, error: 'web-note-engine unavailable: ' + (err && err.message) };
  }

  const engine = webnote.getEngine(slug);
  // Node id: deterministic per topic+date so re-running a cycle replaces
  // rather than duplicates. Web-note addNode refuses overwrite, so we
  // detect existence first and skip on collision (the JSON report file
  // is the canonical record either way).
  const safeTopic = String(report.topic || 'unknown').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40) || 'topic';
  const safeDate = String(report.date || '').replace(/[^0-9-]+/g, '') || _todayKey();
  const hash = crypto.createHash('sha256').update(`${slug}|${safeTopic}|${safeDate}`).digest('hex').slice(0, 6);
  const nodeId = `radar-${safeTopic}-${safeDate}-${hash}`;

  // Check existence — if present, skip + return existing id rather than
  // throw. This keeps `runRadarCycle` idempotent on same-day re-runs.
  const existing = engine.getNode(nodeId);
  if (existing && existing.ok) {
    return { ok: true, node_id: nodeId, deduped: true };
  }

  const body = frontierReport.formatReportMarkdown(report);

  // W7.3 Citation + Global Trust — harvest URLs out of the rendered report
  // markdown, classify each, persist as a citations[] frontmatter slot so
  // the Notebook surface can render trust badges + flag phishing/shortener
  // links before the user clicks. Best-effort; report node ships even if
  // citation-system fails to load (defensive — radar must keep working).
  let _w73Citations = [];
  let _w73Worst = 'safe';
  try {
    const _cs = require('../citation-system');
    const _w73 = _cs.harvestCitationsFromText(body, { intent: 'private_learn' });
    _w73Citations = _w73.map(h => ({
      url: h.citation.source_url,
      type: h.citation.type,
      trust_score: h.trust.score,
      tier: h.tier,
      risk_level: h.risk.risk_level,
    }));
    const tierRank = { safe: 0, caution: 1, unsafe: 2, phishing: 3 };
    for (const c of _w73Citations) {
      if ((tierRank[c.tier] || 0) > (tierRank[_w73Worst] || 0)) _w73Worst = c.tier;
    }
  } catch (_) { /* W7.3 annotation is best-effort */ }

  const result = engine.addNode({
    id: nodeId,
    layer: 'raw',
    content: body,
    frontmatter: {
      source: 'research-radar',
      topic: report.topic,
      date: report.date,
      report_items: Array.isArray(report.items) ? report.items.length : 0,
      has_spark_candidates: Array.isArray(report.product_spark_candidates) && report.product_spark_candidates.length > 0,
      citations: _w73Citations,
      citations_worst_tier: _w73Worst,
    },
  });
  if (!result || !result.ok) {
    return { ok: false, error: 'webnote.addNode failed: ' + (result && result.error) };
  }
  return { ok: true, node_id: nodeId };
}

// =====================================================================
// 2. lessonCitationHook — 7-day window read, returns injection string
// =====================================================================

/**
 * Read recent (last 7 days) frontier reports for this slug and return
 * a CITATION BLOCK string suitable for injection into designLesson's
 * system prompt. Returns empty string when no recent reports exist —
 * caller must safely handle that (no-op append).
 *
 * @param {string} slug
 * @param {number} [lessonIdx] - currently informational only (logged for tracing)
 * @returns {{ ok:true, citation_block:string, reports_used:number, reports:Array<object> }}
 */
function lessonCitationHook(slug, lessonIdx) {
  if (!slug) return { ok: false, error: 'slug required' };
  const allReports = radar.listAllReports(slug);
  if (allReports.length === 0) {
    return { ok: true, citation_block: '', reports_used: 0, reports: [] };
  }
  const now = Date.now();
  const recent = allReports.filter(r => {
    const ts = Date.parse(r.generated_at || '') || (r.date ? Date.parse(r.date + 'T00:00:00Z') : 0);
    if (!Number.isFinite(ts) || ts <= 0) return false;
    return (now - ts) <= SEVEN_DAYS_MS;
  });
  if (recent.length === 0) {
    return { ok: true, citation_block: '', reports_used: 0, reports: [] };
  }

  // Build injection block — terse register, max 3 reports surfaced so
  // we never blow the lesson body prompt budget. The lesson decides how
  // to weave the citation (we never dictate exact placement).
  const sliced = recent.slice(0, 3);
  const lines = [];
  lines.push('===== FRONTIER CITATIONS (last 7 days) =====');
  lines.push('Use ONLY if a citation actually clarifies the lesson — never as decoration.');
  lines.push('');
  for (const rep of sliced) {
    lines.push(`Topic: ${rep.topic} · ${rep.date}`);
    if (rep.synthesis_paragraph) {
      lines.push(`  ${rep.synthesis_paragraph}`);
    }
    const top = Array.isArray(rep.items) ? rep.items.slice(0, 3) : [];
    for (const it of top) {
      const url = it.url ? ` (${it.url})` : '';
      lines.push(`  - [${it.source}] ${it.title}${url}`);
    }
    lines.push('');
  }
  lines.push('===== END FRONTIER CITATIONS =====');
  return {
    ok: true,
    citation_block: lines.join('\n'),
    reports_used: sliced.length,
    reports: sliced,
    lesson_idx: typeof lessonIdx === 'number' ? lessonIdx : null,
  };
}

// =====================================================================
// 3. triggerProductSparkCandidate — seed a product spark from a report
// =====================================================================

/**
 * Promote one product_spark_candidate from a Frontier Report into a real
 * W3.4 Product Spark (state='seed', source.type='research'). The spark
 * lifecycle then runs through product-spark.transitionState as usual.
 *
 * @param {string} slug
 * @param {object} candidate - { title, core_transfer, related_product?, risk?, _source_url? }
 * @param {object} [reportContext] - { topic, date } the spark originated from
 * @returns {{ ok:true, spark_id:string, path:string } | { ok:false, error:string }}
 */
function triggerProductSparkCandidate(slug, candidate, reportContext = {}) {
  if (!slug) return { ok: false, error: 'slug required' };
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, error: 'candidate required (object with title + core_transfer)' };
  }
  if (!candidate.title || !candidate.core_transfer) {
    return { ok: false, error: 'candidate must have title and core_transfer' };
  }

  let productSpark;
  try { productSpark = require('../product-spark'); }
  catch (err) {
    return { ok: false, error: 'product-spark module unavailable: ' + (err && err.message) };
  }

  // Build sparkData shaped to W3.4 createSpark contract.
  const sourceRef = candidate._source_url
    || (reportContext.topic && reportContext.date ? `research-radar:${reportContext.topic}:${reportContext.date}` : 'research-radar');
  const sparkData = {
    state: 'seed',
    source: {
      // Note: W3.4 SOURCE_TYPES is ['lesson','note','book','pack']. We pass
      // 'note' as the canonical type (the report is also stored as a webnote
      // raw node via storeAsNote) and tag the originating system in `label`
      // so the audit trail is preserved without expanding the W3.4 schema.
      type: 'note',
      ref: sourceRef,
      label: 'research-radar',
    },
    related_product: candidate.related_product || '',
    core_transfer: candidate.core_transfer,
    affected_modules: [],
    possible_actions: candidate._source_url
      ? [`Open source: ${candidate._source_url}`]
      : [],
    risk: candidate.risk || '',
  };

  try {
    const result = productSpark.createSpark(slug, sparkData);
    return { ok: true, spark_id: result.spark_id, path: result.path };
  } catch (err) {
    return { ok: false, error: 'createSpark failed: ' + (err && err.message), code: err && err.code };
  }
}

// =====================================================================
// Helpers
// =====================================================================

function _todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

module.exports = {
  storeAsNote,
  lessonCitationHook,
  triggerProductSparkCandidate,
  SEVEN_DAYS_MS,
};
