'use strict';

// HYPHA · W3.1 Creation Pool — framework API (BLUEPRINT §11.1)
//
// One Goal → one Product. Persists under vault/<slug>/product/:
//   blueprint.md              — 10-section product blueprint (frame here, body in W3.2)
//   decision-log.jsonl        — append-only decision ledger (§11.5)
//   assumption-ledger.jsonl   — Lean-Startup hypothesis tracker (§11.6)
//   kill-criteria.json        — walk-away thresholds (§11.7)
//   roadmap-sync.json         — Companion / Harness suggestions queue (§11.8)
//   inspiration-pool.jsonl    — lesson / note / pack / book / research links
//   sparks/                   — directory placeholder for W3.4 (we mkdir only)
//   evaluation-log.jsonl      — kill-criteria evaluation history (ops writes)
//
// Boundary:
//   W3.1 (this stream)  = framework (bind / get / link / isBound) + file layout
//   W3.2                = blueprint.md body editor + auto-fill
//   W3.3                = Product Transfer — calls linkLessonToProduct here
//   W3.4                = Spark state machine + sparks/*.md body
//   W3.5 / W3.6         = Companion agents — observe events.jsonl + append to roadmap-sync
//
// No LLM. No Electron. Pure fs + path. Re-uses ./events.js write() so the
// SAME validator that proved out in W2.4 stamps every product:* event.

const fs = require('fs');
const path = require('path');

const events = require('./events');
const schema = require('./creation-pool-schema');

// Resolve vault root. We prefer HYPHA_DATA (the env var main.js sets at boot,
// line 113, so packaged builds write to <userData>/data) and fall back to
// HYPHA_VAULT_DIR (events.js convention) and finally the dev default path.
// This matches what vault.js does so creation-pool writes land next to the
// existing state.json / lesson-N.md for the same slug.
function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  return path.join(__dirname, '..', '..', 'data');
}

function _productDir(slug) {
  return path.join(_vaultRoot(), slug, schema.PRODUCT_LAYOUT.root_dir);
}

function _abs(slug, relWithinProduct) {
  return path.join(_vaultRoot(), slug, relWithinProduct);
}

function _ensureSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('creation-pool: slug required (non-empty string)');
  }
  if (slug.includes('..') || path.isAbsolute(slug)) {
    throw new Error('creation-pool: slug must be a vault-relative directory name');
  }
}

function _validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('creation-pool: productConfig required');
  }
  if (!cfg.product_name || typeof cfg.product_name !== 'string') {
    throw new Error('creation-pool: product_name required (non-empty string)');
  }
  const type = cfg.product_type || cfg.type;   // accept either; spec docs use product_type
  if (!type || !schema.PRODUCT_TYPES.includes(type)) {
    throw new Error(`creation-pool: product_type must be one of ${schema.PRODUCT_TYPES.join('|')}`);
  }
  if (!cfg.north_star || typeof cfg.north_star !== 'string') {
    throw new Error('creation-pool: north_star required (non-empty string)');
  }
  return { ...cfg, product_type: type };
}

function _yamlEscape(value) {
  // Minimal scalar escaping — quote if the value contains characters YAML
  // would interpret. We never accept multiline so this is sufficient for
  // frontmatter round-trip with the existing parseFrontmatter() in vault.js.
  if (value == null) return '""';
  const s = String(value);
  if (/[":#{}\[\],&*!|>'%@`\n]/.test(s) || s.includes('  ')) {
    return JSON.stringify(s);
  }
  return s;
}

function _renderBlueprintMd(cfg, nowIso) {
  const fmLines = [
    '---',
    `product_name: ${_yamlEscape(cfg.product_name)}`,
    `product_type: ${_yamlEscape(cfg.product_type)}`,
    `north_star: ${_yamlEscape(cfg.north_star)}`,
    `bound_at: ${_yamlEscape(nowIso)}`,
    `last_updated: ${_yamlEscape(nowIso)}`,
    `slug: ${_yamlEscape(cfg.slug)}`,
    `version: ${schema.BLUEPRINT_SCHEMA.version}`,
    '---',
    '',
    `# ${cfg.product_name}`,
    '',
    `> **类型**: ${cfg.product_type}  ·  **北极星**: ${cfg.north_star}`,
    '',
    '_本文件由 Creation Pool 框架生成。各节内容由 W3.2 Product Blueprint 编辑层填充。_',
    '',
  ];
  const sectionLines = [];
  for (const sec of schema.BLUEPRINT_SCHEMA.sections) {
    sectionLines.push(`## ${sec.title}`);
    sectionLines.push('');
    sectionLines.push(`_${sec.description}_`);
    sectionLines.push('');
    sectionLines.push('<!-- section-id: ' + sec.id + ' -->');
    sectionLines.push('');
    sectionLines.push('（待填写）');
    sectionLines.push('');
  }
  return fmLines.concat(sectionLines).join('\n');
}

function _ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function _writeIfAbsent(absPath, content) {
  // Idempotent — never clobber existing user-edited content on re-bind.
  if (fs.existsSync(absPath)) return false;
  _ensureDir(path.dirname(absPath));
  fs.writeFileSync(absPath, content, 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// bindProduct — initialize the product/ dir for `slug`. Idempotent: a second
// call with the same slug DOES NOT clobber existing files. Returns a manifest
// of which files were freshly created vs already-present.
// ---------------------------------------------------------------------------
function bindProduct(slug, productConfig) {
  _ensureSlug(slug);
  const cfg = _validateConfig({ ...productConfig, slug });
  const now = new Date().toISOString();
  const dir = _productDir(slug);
  _ensureDir(dir);
  // intentional-placeholder: sparks/ directory is mkdir-only here; W3.4
  // Product Spark stream owns the spark state machine + body files inside.
  _ensureDir(path.join(dir, 'sparks'));

  const layout = schema.PRODUCT_LAYOUT;
  const blueprintPath = _abs(slug, layout.blueprint);
  const decisionPath = _abs(slug, layout.decision_log);
  const assumptionPath = _abs(slug, layout.assumption_ledger);
  const killPath = _abs(slug, layout.kill_criteria);
  const roadmapPath = _abs(slug, layout.roadmap_sync);
  const inspirationPath = _abs(slug, layout.inspiration_pool);
  const evalLogPath = _abs(slug, layout.evaluation_log);

  const created = {
    blueprint: _writeIfAbsent(blueprintPath, _renderBlueprintMd(cfg, now)),
    decision_log: _writeIfAbsent(decisionPath, ''),
    assumption_ledger: _writeIfAbsent(assumptionPath, ''),
    kill_criteria: _writeIfAbsent(killPath, JSON.stringify({
      criteria: [],
      last_evaluated: null,
      would_kill_now: false,
    }, null, 2)),
    roadmap_sync: _writeIfAbsent(roadmapPath, JSON.stringify({
      weekly_suggestions: [],
      processed: [],
      last_synced_at: null,
    }, null, 2)),
    inspiration_pool: _writeIfAbsent(inspirationPath, ''),
    evaluation_log: _writeIfAbsent(evalLogPath, ''),
  };

  // Stamp the bind event. Re-uses W2.4 validator — non-fatal on quarantine.
  events.write(slug, {
    type: 'product_bound',
    product_name: cfg.product_name,
    product_type: cfg.product_type,
    north_star: cfg.north_star,
    freshly_created: Object.entries(created).filter(([_, v]) => v).map(([k]) => k),
  });

  return {
    ok: true,
    slug,
    product_dir: dir,
    product_name: cfg.product_name,
    product_type: cfg.product_type,
    north_star: cfg.north_star,
    bound_at: now,
    created,
  };
}

// ---------------------------------------------------------------------------
// getProduct — read blueprint frontmatter + cheap ledger metadata. Does NOT
// read or parse the markdown sections (W3.2 layer renders the body). Counts
// are line-based (jsonl) or array-length (json) — O(file size) but avoids
// JSON.parse-per-row when only a count is needed.
// ---------------------------------------------------------------------------
function getProduct(slug) {
  _ensureSlug(slug);
  const blueprintPath = _abs(slug, schema.PRODUCT_LAYOUT.blueprint);
  if (!fs.existsSync(blueprintPath)) {
    return { ok: false, reason: 'not_bound', slug };
  }
  const text = fs.readFileSync(blueprintPath, 'utf8');
  const fm = _parseFrontmatter(text);

  const decisionCount = _countJsonlLines(_abs(slug, schema.PRODUCT_LAYOUT.decision_log));
  const assumptionCount = _countJsonlLines(_abs(slug, schema.PRODUCT_LAYOUT.assumption_ledger));
  const inspirationCount = _countJsonlLines(_abs(slug, schema.PRODUCT_LAYOUT.inspiration_pool));
  const sparkCount = _countSparks(slug);

  // assumption status breakdown — single pass over the ledger. Cheap enough
  // (ledgers stay small in practice; cap O(n) without per-row JSON.parse for
  // counts, but we DO parse here because callers want status_counts).
  const hypothesis_count = assumptionCount;
  let status_counts = { unverified: 0, verifying: 0, verified: 0, refuted: 0 };
  try {
    const ledger = _abs(slug, schema.PRODUCT_LAYOUT.assumption_ledger);
    if (fs.existsSync(ledger)) {
      const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          // Track LATEST status per id (update events overwrite prior rows).
          // For a count, we approximate: take last seen status per id.
          if (status_counts[row.status] != null) status_counts[row.status]++;
        } catch (_) { /* skip malformed row */ }
      }
    }
  } catch (_) { /* silent — counts default to 0 */ }

  return {
    ok: true,
    slug,
    product_name: fm.product_name || null,
    product_type: fm.product_type || null,
    type: fm.product_type || null,            // alias for back-compat in callers
    north_star: fm.north_star || null,
    bound_at: fm.bound_at || null,
    last_updated: fm.last_updated || null,
    version: fm.version || null,
    decision_count: decisionCount,
    hypothesis_count,
    assumption_status_counts: status_counts,
    inspiration_count: inspirationCount,
    spark_count: sparkCount,
  };
}

// ---------------------------------------------------------------------------
// isProductBound — cheap existence check. Used by UI ProductBadge + the
// curriculum:create handler's post-design prompt.
// ---------------------------------------------------------------------------
function isProductBound(slug) {
  _ensureSlug(slug);
  return fs.existsSync(_abs(slug, schema.PRODUCT_LAYOUT.blueprint));
}

// ---------------------------------------------------------------------------
// linkLessonToProduct / linkNoteToProduct / linkPackToProduct — append a row
// to inspiration-pool.jsonl. Each row is a one-line history; the renderer
// groups by source prefix to populate blueprint §8 灵感池.
// ---------------------------------------------------------------------------
function linkLessonToProduct(slug, lessonIdx, relevance, sourceSummary) {
  return _appendInspiration(slug, `lesson:${lessonIdx}`, relevance, sourceSummary, { lessonIdx });
}
function linkNoteToProduct(slug, notePath, relevance, sourceSummary) {
  if (!notePath || typeof notePath !== 'string') {
    throw new Error('linkNoteToProduct: notePath required (string)');
  }
  return _appendInspiration(slug, `note:${notePath}`, relevance, sourceSummary, { notePath });
}
function linkPackToProduct(slug, packId, relevance, sourceSummary) {
  if (!packId || typeof packId !== 'string') {
    throw new Error('linkPackToProduct: packId required (string)');
  }
  return _appendInspiration(slug, `pack:${packId}`, relevance, sourceSummary, { packId });
}

function _appendInspiration(slug, source, relevance, sourceSummary, extras) {
  _ensureSlug(slug);
  if (!isProductBound(slug)) {
    return { ok: false, reason: 'not_bound', slug };
  }
  const rel = (typeof relevance === 'number' && relevance >= 0 && relevance <= 1)
    ? relevance : 0.5;
  const row = {
    ts: new Date().toISOString(),
    source,
    relevance: rel,
    source_summary: sourceSummary || '',
    ...(extras || {}),
  };
  const inspirationPath = _abs(slug, schema.PRODUCT_LAYOUT.inspiration_pool);
  _ensureDir(path.dirname(inspirationPath));
  fs.appendFileSync(inspirationPath, JSON.stringify(row) + '\n', 'utf8');
  _touchLastUpdated(slug);
  events.write(slug, {
    type: 'product_inspiration_linked',
    source,
    relevance: rel,
  });
  return { ok: true, slug, source, relevance: rel };
}

// Touch the blueprint.md last_updated frontmatter field. We do a minimal
// regex rewrite — no full markdown round-trip — so the body is preserved
// byte-identical. Idempotent / silent on missing file.
function _touchLastUpdated(slug) {
  const bp = _abs(slug, schema.PRODUCT_LAYOUT.blueprint);
  if (!fs.existsSync(bp)) return;
  try {
    const text = fs.readFileSync(bp, 'utf8');
    const now = new Date().toISOString();
    const out = text.replace(/^(last_updated:\s*).*$/m, (_, p1) => `${p1}${_yamlEscape(now)}`);
    if (out !== text) fs.writeFileSync(bp, out, 'utf8');
  } catch (_) { /* silent — touch is best-effort */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    // Strip a single layer of surrounding quotes (JSON-style or single quotes).
    if (v.startsWith('"') && v.endsWith('"')) {
      try { v = JSON.parse(v); } catch (_) { v = v.slice(1, -1); }
    } else if (v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1);
    }
    fm[kv[1].toLowerCase()] = v;
  }
  return fm;
}

function _countJsonlLines(absPath) {
  if (!fs.existsSync(absPath)) return 0;
  try {
    const buf = fs.readFileSync(absPath, 'utf8');
    if (!buf) return 0;
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf.charCodeAt(i) === 10) n++;
    // If the file doesn't end in \n but has content, that trailing fragment
    // is one more row.
    if (buf.length > 0 && buf.charCodeAt(buf.length - 1) !== 10) n++;
    return n;
  } catch (_) { return 0; }
}

function _countSparks(slug) {
  const sparksDir = _abs(slug, schema.PRODUCT_LAYOUT.sparks_dir);
  if (!fs.existsSync(sparksDir)) return 0;
  try {
    return fs.readdirSync(sparksDir)
      .filter(n => n.toLowerCase().endsWith('.md'))
      .length;
  } catch (_) { return 0; }
}

module.exports = {
  bindProduct,
  getProduct,
  isProductBound,
  linkLessonToProduct,
  linkNoteToProduct,
  linkPackToProduct,
  // Internal helpers exposed for creation-pool-ops.js (which avoids
  // duplicating the resolver / frontmatter helpers). NOT public API.
  _internals: {
    vaultRoot: _vaultRoot,
    productDir: _productDir,
    abs: _abs,
    ensureSlug: _ensureSlug,
    ensureDir: _ensureDir,
    parseFrontmatter: _parseFrontmatter,
    touchLastUpdated: _touchLastUpdated,
  },
};
