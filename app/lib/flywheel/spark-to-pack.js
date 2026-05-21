'use strict';

// HYPHA · W8.2 Learning Commons Flywheel · Step 2 — Spark → Pack
//
// Aggregates Spark clusters + Product Blueprints + Book Spark Packs into
// shareable Pack drafts. SECOND hop of the §20 v2.5 flywheel:
//
//     Sparks (W3.4)
//     Blueprint (W3.2) ─┐
//     Book Spark Pack (W6.2) ─┼─▶ [evaluateSparkClusterForPack]
//                              │  [proposeSparkClusterToPack]
//                              │  [proposeProductBlueprintTemplate]
//                              │  [proposeBookSparkPackPublic]
//                              ▼
//                          Pack draft (YAML)
//                          → goes to W8.2 Step 3 (pack-to-commons)
//
// Boundary contract:
//   - Reads W3.4 product-spark.listSparks and W3.2 blueprint-template
//     (best-effort load; degrade with [DEGRADED] reason tag if absent).
//   - Reads W6.2 Book Spark Pack manifests when proposeBookSparkPackPublic
//     is invoked.
//   - Does NOT call LLM. Eligibility = deterministic count rule.
//   - Does NOT publish. Output = in-memory YAML draft. Step 3 stages it.
//
// Eligibility (cumulative-or — EITHER rule sufficient):
//   A. >= MIN_CLUSTER_SIZE sparks share the same affected_module, OR
//   B. >= MIN_ACCEPTED_PLUS sparks are in state ∈ {accepted, implemented}
//
// Pack draft shape mirrors commons-packs/<topic>-<lang>/pack.json so the
// downstream commons layer (W6.5) recognizes the structure without
// per-source translation.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const MIN_CLUSTER_SIZE = 5;
const MIN_ACCEPTED_PLUS = 3;
const ACCEPTED_PLUS_STATES = Object.freeze(['accepted', 'implemented']);

// ---------------------------------------------------------------------------
// Best-effort lib loading
// ---------------------------------------------------------------------------

let _productSpark = null;
try { _productSpark = require('../product-spark'); } catch (_) { _productSpark = null; }

let _blueprintTemplate = null;
try { _blueprintTemplate = require('../blueprint-template'); } catch (_) { _blueprintTemplate = null; }

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function _vaultRoot() {
  if (process.env.HYPHA_VAULT_ROOT) return process.env.HYPHA_VAULT_ROOT;
  return path.join(process.cwd(), 'vault');
}

function _slugDir(slug) {
  if (!slug) throw new TypeError('slug required');
  return path.join(_vaultRoot(), slug);
}

// ---------------------------------------------------------------------------
// Cluster detection helpers
// ---------------------------------------------------------------------------

function _resolveSparkObjects(slug, sparkIds) {
  if (!_productSpark || typeof _productSpark.getSpark !== 'function') {
    return { resolved: [], degraded: true };
  }
  const resolved = [];
  for (const id of (sparkIds || [])) {
    try {
      const s = _productSpark.getSpark(slug, id);
      if (s) resolved.push(s);
    } catch (_) { /* skip missing */ }
  }
  return { resolved, degraded: false };
}

function _moduleHistogram(sparks) {
  const hist = new Map();
  for (const s of sparks) {
    for (const m of (s.affected_modules || [])) {
      hist.set(m, (hist.get(m) || 0) + 1);
    }
  }
  return hist;
}

function _topModule(sparks) {
  const hist = _moduleHistogram(sparks);
  let best = null;
  let bestCount = 0;
  for (const [m, n] of hist.entries()) {
    if (n > bestCount) { best = m; bestCount = n; }
  }
  return { module: best, count: bestCount };
}

// ---------------------------------------------------------------------------
// YAML rendering — small subset (no dep). Pack files are simple key/list shapes.
// ---------------------------------------------------------------------------

function _yamlEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[:#\n\[\]{}&*?|>!%@`,'"]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function _renderYaml(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v == null) { lines.push(`${pad}${key}: ~`); continue; }
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${pad}${key}: []`); continue; }
      lines.push(`${pad}${key}:`);
      for (const item of v) {
        if (item && typeof item === 'object') {
          lines.push(`${pad}  -`);
          lines.push(_renderYaml(item, indent + 2));
        } else {
          lines.push(`${pad}  - ${_yamlEscape(item)}`);
        }
      }
      continue;
    }
    if (typeof v === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(_renderYaml(v, indent + 1));
      continue;
    }
    lines.push(`${pad}${key}: ${_yamlEscape(v)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a candidate spark set qualifies as a Pack.
 *
 * @param {string}   slug
 * @param {string[]} sparkIds
 * @returns {{ eligible: boolean, pack_skeleton: object, reasons: string[] }}
 */
function evaluateSparkClusterForPack(slug, sparkIds) {
  if (!Array.isArray(sparkIds)) {
    throw new TypeError('sparkIds must be an array');
  }
  const reasons = [];
  const { resolved, degraded } = _resolveSparkObjects(slug, sparkIds);

  if (degraded) reasons.push('product_spark_lib_missing:degrade-open');

  // Rule A — same affected_module ≥ MIN_CLUSTER_SIZE
  const top = _topModule(resolved);
  const ruleA = top.count >= MIN_CLUSTER_SIZE;
  if (ruleA) {
    reasons.push(`cluster_module_ok:${top.module}=${top.count}>=${MIN_CLUSTER_SIZE}`);
  } else {
    reasons.push(`cluster_module_low:${top.module || 'none'}=${top.count}<${MIN_CLUSTER_SIZE}`);
  }

  // Rule B — ≥ MIN_ACCEPTED_PLUS in accepted+implemented
  const acceptedPlus = resolved.filter(s => ACCEPTED_PLUS_STATES.includes(s.state)).length;
  const ruleB = acceptedPlus >= MIN_ACCEPTED_PLUS;
  if (ruleB) {
    reasons.push(`accepted_plus_ok:${acceptedPlus}>=${MIN_ACCEPTED_PLUS}`);
  } else {
    reasons.push(`accepted_plus_low:${acceptedPlus}<${MIN_ACCEPTED_PLUS}`);
  }

  const eligible = (ruleA || ruleB) && resolved.length > 0;

  const skeleton = {
    schema_version: 1,
    pack_kind: 'spark-cluster',
    topic_slug: `${slug}-cluster`,
    author: 'hypha-user',
    title: top.module
      ? `Spark cluster: ${top.module}`
      : `Spark cluster from ${slug}`,
    summary: '',
    affected_module: top.module || null,
    spark_count: resolved.length,
    sparks: resolved.map(s => ({
      spark_id: s.spark_id,
      state: s.state,
      core_transfer: s.core_transfer || '',
    })),
    license: 'CC-BY-4.0',
    created_at: new Date().toISOString(),
  };

  return { eligible, pack_skeleton: skeleton, reasons };
}

/**
 * Build a pack draft (YAML + skeleton object) from a cluster.
 *
 * @returns {{ ok: boolean, packId: string, yaml: string, skeleton: object, evaluation: object }}
 */
function proposeSparkClusterToPack(slug, sparkIds) {
  const evalRes = evaluateSparkClusterForPack(slug, sparkIds);
  if (!evalRes.eligible) {
    return { ok: false, error: 'not_eligible', evaluation: evalRes };
  }
  const skeleton = evalRes.pack_skeleton;
  const packId = `${skeleton.topic_slug}-${Date.now()}`;
  const yaml = _renderYaml({ ...skeleton, pack_id: packId });
  return { ok: true, packId, yaml, skeleton, evaluation: evalRes };
}

/**
 * Convert a Product Blueprint (W3.2) into a reusable template pack.
 * Strips slug-specific identifiers, keeps section structure + risk taxonomy.
 *
 * @param {string} slug
 * @returns {{ ok: boolean, packId: string, yaml: string, skeleton: object }}
 */
function proposeProductBlueprintTemplate(slug) {
  if (!_blueprintTemplate || typeof _blueprintTemplate.parseBlueprint !== 'function') {
    return { ok: false, error: 'blueprint_template_lib_missing' };
  }
  const candidatePath = path.join(_slugDir(slug), 'product', 'blueprint.md');
  let parsed = null;
  if (fs.existsSync(candidatePath)) {
    try {
      const raw = fs.readFileSync(candidatePath, 'utf8');
      parsed = _blueprintTemplate.parseBlueprint(raw);
    } catch (err) {
      return { ok: false, error: `blueprint_parse_failed:${err.message}` };
    }
  }

  // If no concrete blueprint exists, ship the empty section skeleton.
  const sections = parsed && parsed.sections
    ? parsed.sections
    : (typeof _blueprintTemplate.emptySections === 'function'
        ? _blueprintTemplate.emptySections() : {});

  const skeleton = {
    schema_version: 1,
    pack_kind: 'blueprint-template',
    topic_slug: `${slug}-blueprint-template`,
    author: 'hypha-user',
    title: `Blueprint template (from ${slug})`,
    summary: 'Reusable Product Blueprint scaffold extracted via the Flywheel.',
    sections,
    license: 'CC-BY-4.0',
    created_at: new Date().toISOString(),
  };
  const packId = `${skeleton.topic_slug}-${Date.now()}`;
  return {
    ok: true,
    packId,
    yaml: _renderYaml({ ...skeleton, pack_id: packId }),
    skeleton,
  };
}

/**
 * Convert a W6.2 Book Spark Pack into a Commons publish candidate.
 * Reads vault/<slug>/library/spark-packs/<bookId>.json.
 *
 * @param {string} bookId
 * @param {string} slug
 * @returns {{ ok: boolean, packId: string, yaml: string, skeleton: object }}
 */
function proposeBookSparkPackPublic(bookId, slug) {
  if (!bookId) return { ok: false, error: 'bookId required' };
  const dir = _slugDir(slug);
  // Try a few conventional locations (W6.2 layout may vary).
  const candidates = [
    path.join(dir, 'library', 'spark-packs', `${bookId}.json`),
    path.join(dir, 'library', 'spark-packs', bookId, 'pack.json'),
    path.join(dir, 'book-spark-packs', `${bookId}.json`),
  ];
  let found = null;
  let foundPath = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try { found = JSON.parse(fs.readFileSync(p, 'utf8')); foundPath = p; break; }
      catch (_) { /* try next */ }
    }
  }
  if (!found) {
    return { ok: false, error: 'book_spark_pack_not_found', searched: candidates };
  }

  const skeleton = {
    schema_version: 1,
    pack_kind: 'book-spark-pack',
    topic_slug: `${slug}-${bookId}`,
    author: found.author || 'hypha-user',
    title: found.title || `Book Spark Pack: ${bookId}`,
    summary: found.summary || '',
    book_id: bookId,
    sparks: Array.isArray(found.sparks) ? found.sparks : [],
    license: found.license || 'CC-BY-4.0',
    source_path: foundPath,
    created_at: new Date().toISOString(),
  };
  const packId = `${skeleton.topic_slug}-${Date.now()}`;
  return {
    ok: true,
    packId,
    yaml: _renderYaml({ ...skeleton, pack_id: packId }),
    skeleton,
  };
}

module.exports = {
  evaluateSparkClusterForPack,
  proposeSparkClusterToPack,
  proposeProductBlueprintTemplate,
  proposeBookSparkPackPublic,
  MIN_CLUSTER_SIZE,
  MIN_ACCEPTED_PLUS,
  ACCEPTED_PLUS_STATES,
  _internals: {
    resolveSparkObjects: _resolveSparkObjects,
    moduleHistogram: _moduleHistogram,
    topModule: _topModule,
    renderYaml: _renderYaml,
    yamlEscape: _yamlEscape,
  },
};
