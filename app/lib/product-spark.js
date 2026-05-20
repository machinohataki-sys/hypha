'use strict';

// HYPHA · W3.4 Product Spark — state machine + sparks/*.md CRUD (BLUEPRINT §11.4)
//
// One vault/<slug>/product/sparks/spark-<id>.md per spark. Pure fs + path.
// No LLM. No Electron. Boundary partners:
//   W3.1 creation-pool  — owns vault/<slug>/product/ layout (we read sparks_dir).
//   W3.2 blueprint body — linkSparkToBlueprint appends to inspiration-pool.jsonl
//                         (W3.2 will later parse + render in Inspiration Pool §).
//   W3.3 product-transfer — UI calls createSpark from a transfer suggestion.
//   W3.5/W3.6 Companion — listens to transition events (state changes) and may
//                          surface them through agent-state.js (we emit but do
//                          not call companion code directly — file-as-substrate).
//
// State machine (per task brief — distinct from creation-pool-schema.js
// SPARK_LIFECYCLE which uses a different vocabulary; W3.4 owns this surface):
//
//   seed ──▶ considered ──▶ accepted ──▶ implemented   (terminal)
//     │            │            │
//     └────────────┴────────────┴────▶ rejected         (terminal)
//
// Illegal transitions throw SparkStateError synchronously — never silently
// swallowed. Every transition appends a row to frontmatter.transitions[] so
// the audit trail survives even if the file is hand-edited later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// W3.1 ships a layout constant. We import for sparks_dir + root_dir so the
// two streams stay aligned without a copy. The require is wrapped to keep
// product-spark.js usable in environments where creation-pool-schema is
// absent (tests, dry-runs) — falls back to the literal layout in that case.
let PRODUCT_LAYOUT;
try {
  ({ PRODUCT_LAYOUT } = require('./creation-pool-schema'));
} catch (_) {
  PRODUCT_LAYOUT = Object.freeze({
    root_dir: 'product',
    sparks_dir: 'product/sparks',
    inspiration_pool: 'product/inspiration-pool.jsonl',
  });
}

// Best-effort: optional event-log integration. We only call events.write
// when the helper loads cleanly. Failures degrade silently to file-only —
// the canonical record is sparks/*.md, events.jsonl is a redundant index.
let _events = null;
try { _events = require('./events'); } catch (_) { _events = null; }

// =====================================================================
// Constants
// =====================================================================

const STATES = Object.freeze(['seed', 'considered', 'accepted', 'rejected', 'implemented']);

// State machine — directed adjacency. Terminal states have empty arrays.
const TRANSITIONS = Object.freeze({
  seed:        Object.freeze(['considered', 'rejected']),
  considered:  Object.freeze(['accepted', 'rejected']),
  accepted:    Object.freeze(['implemented', 'rejected']),
  rejected:    Object.freeze([]),
  implemented: Object.freeze([]),
});

const TERMINAL_STATES = Object.freeze(['rejected', 'implemented']);

const SOURCE_TYPES = Object.freeze(['lesson', 'note', 'book', 'pack']);

const AFFECTED_MODULES_KNOWN = Object.freeze([
  'Lesson', 'Note', 'Commons', 'Library', 'Companion', 'Pricing', 'Security',
]);

// =====================================================================
// Errors
// =====================================================================

class SparkStateError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = 'SparkStateError';
    this.code = 'SPARK_STATE_INVALID';
    if (meta && typeof meta === 'object') Object.assign(this, meta);
  }
}

class SparkValidationError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = 'SparkValidationError';
    this.code = 'SPARK_INPUT_INVALID';
    if (meta && typeof meta === 'object') Object.assign(this, meta);
  }
}

class SparkNotFoundError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = 'SparkNotFoundError';
    this.code = 'SPARK_NOT_FOUND';
    if (meta && typeof meta === 'object') Object.assign(this, meta);
  }
}

// =====================================================================
// Path resolution — mirror creation-pool.js exactly so spark writes land
// next to product/blueprint.md for the same slug.
// =====================================================================

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  // Final fallback — matches creation-pool.js dev default.
  return path.join(__dirname, '..', '..', 'data');
}

function _ensureSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new SparkValidationError('slug required (non-empty string)');
  }
  if (slug.includes('..') || path.isAbsolute(slug)) {
    throw new SparkValidationError('slug must be a vault-relative directory name');
  }
}

function _sparksDir(slug) {
  return path.join(_vaultRoot(), slug, PRODUCT_LAYOUT.sparks_dir);
}

function _archiveDir(slug) {
  return path.join(_sparksDir(slug), '_archive');
}

function _sparkPath(slug, sparkId) {
  return path.join(_sparksDir(slug), `spark-${sparkId}.md`);
}

function _archivePath(slug, sparkId) {
  return path.join(_archiveDir(slug), `spark-${sparkId}.md`);
}

function _ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// =====================================================================
// ID generation — timestamp + short hash. Slug-friendly: lowercase hex
// only, no path-reserved characters, sortable by creation order.
// =====================================================================

function _generateSparkId(seed) {
  // 14-char base: YYYYMMDDHHmmss compact UTC stamp.
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ts = (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
  // 6-char hash for collision avoidance (≥ 16M space per ts second is plenty).
  const hash = crypto
    .createHash('sha256')
    .update(`${ts}|${seed || ''}|${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  return `${ts}-${hash}`;
}

// =====================================================================
// Markdown render / parse — frontmatter YAML head + sectioned body.
// We hand-roll a tiny YAML scalar/array writer rather than pull js-yaml
// (matches creation-pool.js + lesson-note.js convention).
// =====================================================================

function _yamlScalar(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (/[:#\n"'\\{}\[\],&*!|>%@`]/.test(s) || /^[\s-]/.test(s) || /\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function _yamlInlineArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '[]';
  return '[' + arr.map(item => _yamlScalar(item)).join(', ') + ']';
}

function _renderSparkMd(spark) {
  const fmLines = [
    '---',
    `spark_id: ${_yamlScalar(spark.spark_id)}`,
    `created_at: ${_yamlScalar(spark.created_at)}`,
    `state: ${_yamlScalar(spark.state)}`,
    `source_type: ${_yamlScalar(spark.source && spark.source.type)}`,
    `source_ref: ${_yamlScalar(spark.source && spark.source.ref)}`,
    `related_product: ${_yamlScalar(spark.related_product)}`,
    `affected_modules: ${_yamlInlineArray(spark.affected_modules || [])}`,
    // transitions[] = inline JSON in YAML; round-trips through JSON.parse on read.
    `transitions: ${JSON.stringify(Array.isArray(spark.transitions) ? spark.transitions : [])}`,
    '---',
  ];

  const body = [];
  body.push('');
  body.push('# Product Spark');
  body.push('');

  body.push('## 来源 (Source)');
  body.push('');
  if (spark.source && (spark.source.type || spark.source.ref)) {
    body.push(`- **type**: ${spark.source.type || '_unspecified_'}`);
    body.push(`- **ref**: ${spark.source.ref || '_unspecified_'}`);
    if (spark.source.label) body.push(`- **label**: ${spark.source.label}`);
  } else {
    body.push('_(no source recorded)_');
  }
  body.push('');

  body.push('## 关联产品 (Related Product)');
  body.push('');
  body.push(spark.related_product || '_(unspecified)_');
  body.push('');

  body.push('## 核心迁移 (Core Transfer)');
  body.push('');
  body.push(spark.core_transfer || '_(no transfer recorded — fill in before promoting past seed)_');
  body.push('');

  body.push('## 影响模块 (Affected Modules)');
  body.push('');
  if (Array.isArray(spark.affected_modules) && spark.affected_modules.length > 0) {
    for (const m of spark.affected_modules) body.push(`- ${m}`);
  } else {
    body.push('_(none flagged)_');
  }
  body.push('');

  body.push('## 可能动作 (Possible Actions)');
  body.push('');
  if (Array.isArray(spark.possible_actions) && spark.possible_actions.length > 0) {
    for (const a of spark.possible_actions) body.push(`- ${a}`);
  } else {
    body.push('_(no actions proposed yet)_');
  }
  body.push('');

  body.push('## 风险 (Risk)');
  body.push('');
  body.push(spark.risk || '_(risk not yet articulated)_');
  body.push('');

  body.push('## 状态记录 (Transitions)');
  body.push('');
  const tx = Array.isArray(spark.transitions) ? spark.transitions : [];
  if (tx.length === 0) {
    body.push('_(no transitions — spark still at initial state)_');
  } else {
    body.push('| from | → | to | when | reason |');
    body.push('|---|---|---|---|---|');
    for (const t of tx) {
      const reason = (t.reason || '').replace(/\|/g, '\\|');
      body.push(`| ${t.from} | → | ${t.to} | ${t.ts || ''} | ${reason} |`);
    }
  }
  body.push('');

  return fmLines.join('\n') + '\n' + body.join('\n');
}

// Minimal frontmatter parser — tolerant of hand edits. Returns
// { frontmatter: {…}, body: 'rest of md' }. Unknown keys preserved verbatim.
function _parseSparkMd(text) {
  if (typeof text !== 'string') {
    throw new SparkValidationError('cannot parse non-string spark file');
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) {
    throw new SparkValidationError('spark file missing frontmatter block');
  }
  const fmText = m[1];
  const body = m[2];
  const fm = {};
  const lines = fmText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) continue;
    // JSON array / object → parse.
    if (value.startsWith('[') || value.startsWith('{')) {
      try { fm[key] = JSON.parse(value); continue; } catch (_) { /* fallthrough */ }
    }
    // Quoted scalar → JSON.parse (handles \\ and \" escapes).
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      try {
        // Replace single-quoted YAML with JSON-compatible double-quotes only
        // when safe. Otherwise fall through to literal slice.
        const jsonish = value.startsWith("'") ? '"' + value.slice(1, -1).replace(/"/g, '\\"') + '"' : value;
        fm[key] = JSON.parse(jsonish);
        continue;
      } catch (_) {
        fm[key] = value.slice(1, -1);
        continue;
      }
    }
    // Numbers / booleans / bare strings.
    if (value === 'true') fm[key] = true;
    else if (value === 'false') fm[key] = false;
    else if (/^-?\d+$/.test(value)) fm[key] = parseInt(value, 10);
    else if (/^-?\d+\.\d+$/.test(value)) fm[key] = parseFloat(value);
    else fm[key] = value;
  }
  return { frontmatter: fm, body };
}

// Hydrate a Spark object from parsed frontmatter — fills in defaults so
// downstream code never has to null-check core fields.
function _hydrateFromFrontmatter(fm) {
  return {
    spark_id: fm.spark_id || '',
    created_at: fm.created_at || '',
    state: STATES.includes(fm.state) ? fm.state : 'seed',
    source: {
      type: fm.source_type || '',
      ref: fm.source_ref || '',
    },
    related_product: fm.related_product || '',
    affected_modules: Array.isArray(fm.affected_modules) ? fm.affected_modules : [],
    transitions: Array.isArray(fm.transitions) ? fm.transitions : [],
    // Body-only fields are reconstructed lazily by the caller (UI reads the
    // raw markdown). We keep frontmatter the authoritative state-machine
    // surface so transitions never depend on body section parsing.
  };
}

// Merge body-section text (core_transfer / risk / possible_actions /
// related_product overrides) back into the hydrated spark. Best-effort
// regex extraction so a hand-edited body still round-trips.
function _hydrateFromBody(spark, body) {
  const sectionRe = (heading) => new RegExp(
    `##\\s+${heading}[^\\n]*\\n+([\\s\\S]*?)(?=\\n##\\s|$)`,
    'i',
  );
  const grab = (heading) => {
    const m = sectionRe(heading).exec(body);
    return m ? m[1].trim() : '';
  };
  const transfer = grab('核心迁移');
  if (transfer && !/^_\(.+\)_$/.test(transfer)) spark.core_transfer = transfer;
  const risk = grab('风险');
  if (risk && !/^_\(.+\)_$/.test(risk)) spark.risk = risk;
  const actions = grab('可能动作');
  if (actions && !/^_\(.+\)_$/.test(actions)) {
    spark.possible_actions = actions
      .split(/\r?\n/)
      .map(l => l.replace(/^[\s\-\*]+/, '').trim())
      .filter(Boolean);
  }
  const product = grab('关联产品');
  if (product && !/^_\(.+\)_$/.test(product) && !spark.related_product) {
    spark.related_product = product;
  }
  return spark;
}

function _readSparkFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const { frontmatter, body } = _parseSparkMd(text);
  const spark = _hydrateFromFrontmatter(frontmatter);
  return _hydrateFromBody(spark, body);
}

// =====================================================================
// Validation — every public mutator runs this. Cheap, throws on first
// problem so the caller sees an exact failure cause (no silent coerce).
// =====================================================================

function _validateSparkData(data, { partial = false } = {}) {
  if (!data || typeof data !== 'object') {
    throw new SparkValidationError('sparkData must be an object');
  }
  if (!partial) {
    if (!data.source || typeof data.source !== 'object') {
      throw new SparkValidationError('sparkData.source object required');
    }
    if (!SOURCE_TYPES.includes(data.source.type)) {
      throw new SparkValidationError(
        `source.type must be one of ${SOURCE_TYPES.join('|')}`,
      );
    }
    if (!data.source.ref || typeof data.source.ref !== 'string') {
      throw new SparkValidationError('source.ref required (non-empty string)');
    }
    if (!data.core_transfer || typeof data.core_transfer !== 'string') {
      throw new SparkValidationError('core_transfer required (non-empty string)');
    }
  }
  if (data.affected_modules != null && !Array.isArray(data.affected_modules)) {
    throw new SparkValidationError('affected_modules must be array');
  }
  if (data.possible_actions != null && !Array.isArray(data.possible_actions)) {
    throw new SparkValidationError('possible_actions must be array');
  }
  if (data.state != null && !STATES.includes(data.state)) {
    throw new SparkValidationError(
      `state must be one of ${STATES.join('|')}`,
    );
  }
}

// =====================================================================
// State machine — pure function. Throws SparkStateError on illegal moves.
// =====================================================================

function _assertTransitionLegal(from, to) {
  if (!STATES.includes(from)) {
    throw new SparkStateError(`unknown source state '${from}'`, { from, to });
  }
  if (!STATES.includes(to)) {
    throw new SparkStateError(`unknown target state '${to}'`, { from, to });
  }
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    const isTerminal = TERMINAL_STATES.includes(from);
    const detail = isTerminal
      ? `'${from}' is terminal — no outbound transitions permitted`
      : `legal next states from '${from}' are: ${allowed.join(', ')}`;
    throw new SparkStateError(
      `illegal transition ${from} → ${to}. ${detail}`,
      { from, to, legalNext: allowed, terminal: isTerminal },
    );
  }
}

// =====================================================================
// Public API — Spark CRUD
// =====================================================================

function createSpark(slug, sparkData) {
  _ensureSlug(slug);
  _validateSparkData(sparkData, { partial: false });
  const now = new Date().toISOString();
  const id = _generateSparkId(`${slug}|${sparkData.source && sparkData.source.ref}`);
  const initialState = sparkData.state || 'seed';
  if (!STATES.includes(initialState)) {
    throw new SparkValidationError(`initial state '${initialState}' invalid`);
  }
  // W7.3 Citation + Global Trust — when source carries a URL or attribution,
  // build a citation primitive so downstream consumers (UI footnote /
  // copyright boundary check) can act on it. Best-effort, frontmatter-only.
  let _w73Citation = null;
  try {
    if (sparkData.source && sparkData.source.url) {
      const _cs = require('./citation-system');
      const cite = _cs.createCitation({
        type: 'web_url',
        source_id: sparkData.source.url,
        source_url: sparkData.source.url,
        attribution: sparkData.source.label || sparkData.source.ref || null,
        snippet: sparkData.core_transfer || '',
      });
      const trust = _cs.computeGlobalTrust(cite);
      _w73Citation = { citation: cite, trust_score: trust.score };
    }
  } catch (_) { /* never block spark creation on citation annotation */ }

  const spark = {
    spark_id: id,
    created_at: now,
    state: initialState,
    source: {
      type: sparkData.source.type,
      ref: sparkData.source.ref,
      ...(sparkData.source.label ? { label: sparkData.source.label } : {}),
      ...(sparkData.source.url ? { url: sparkData.source.url } : {}),
    },
    related_product: sparkData.related_product || '',
    core_transfer: sparkData.core_transfer,
    affected_modules: sparkData.affected_modules || [],
    possible_actions: sparkData.possible_actions || [],
    risk: sparkData.risk || '',
    transitions: [], // empty until first transitionState() call
    ...(_w73Citation ? { citation: _w73Citation } : {}),
  };
  const dir = _sparksDir(slug);
  _ensureDir(dir);
  const filePath = _sparkPath(slug, id);
  if (fs.existsSync(filePath)) {
    // Collision is astronomically unlikely (UTC second + 6-hex hash), but
    // surface it explicitly rather than overwrite — data loss > error.
    throw new SparkValidationError(`spark file already exists: ${filePath}`);
  }
  fs.writeFileSync(filePath, _renderSparkMd(spark), 'utf8');

  // Emit a typed event so W3.5/W3.6 Companion / agent-state can observe.
  // events.js writes to vault/<slug>/events.jsonl. Best-effort.
  if (_events && typeof _events.write === 'function') {
    try {
      _events.write(slug, {
        type: 'product:spark:created',
        spark_id: id,
        state: initialState,
        source_type: spark.source.type,
        source_ref: spark.source.ref,
      });
    } catch (_) { /* graceful — file is canonical, event log is index only */ }
  }

  return { ok: true, spark_id: id, state: initialState, path: filePath, spark };
}

function listSparks(slug, filterState) {
  _ensureSlug(slug);
  const dir = _sparksDir(slug);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^spark-.+\.md$/i.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const spark = _readSparkFile(full);
      if (filterState && spark.state !== filterState) continue;
      out.push(spark);
    } catch (_) {
      // Skip malformed file silently from listing; getSpark() will surface
      // the parse error if the caller targets it directly.
    }
  }
  // Newest first (created_at desc → fall back to spark_id desc).
  out.sort((a, b) => {
    if (a.created_at && b.created_at && a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? 1 : -1;
    }
    return a.spark_id < b.spark_id ? 1 : -1;
  });
  return out;
}

function getSpark(slug, sparkId) {
  _ensureSlug(slug);
  if (!sparkId || typeof sparkId !== 'string') {
    throw new SparkValidationError('sparkId required');
  }
  const filePath = _sparkPath(slug, sparkId);
  if (!fs.existsSync(filePath)) {
    throw new SparkNotFoundError(`spark '${sparkId}' not found in ${slug}`);
  }
  return _readSparkFile(filePath);
}

function updateSpark(slug, sparkId, patch) {
  _ensureSlug(slug);
  if (!patch || typeof patch !== 'object') {
    throw new SparkValidationError('patch object required');
  }
  // updateSpark NEVER moves state — that path runs through transitionState
  // so we can validate the transition and append a transitions[] row.
  if ('state' in patch) {
    throw new SparkValidationError('use transitionState() to move spark state — updateSpark refuses state edits');
  }
  if ('spark_id' in patch || 'created_at' in patch || 'transitions' in patch) {
    throw new SparkValidationError('immutable field in patch: spark_id / created_at / transitions are managed by the engine');
  }
  _validateSparkData(patch, { partial: true });

  const current = getSpark(slug, sparkId);
  // Merge — patched fields override, untouched fields preserved verbatim.
  // Source sub-fields merge shallowly so callers can patch label without
  // re-supplying ref+type.
  const merged = {
    ...current,
    ...patch,
    source: { ...(current.source || {}), ...(patch.source || {}) },
  };
  // Re-validate the merged shape as a defense-in-depth check (catches
  // patches that accidentally clear a required field with empty string).
  if (!merged.core_transfer || typeof merged.core_transfer !== 'string') {
    throw new SparkValidationError('patch left core_transfer empty');
  }

  fs.writeFileSync(_sparkPath(slug, sparkId), _renderSparkMd(merged), 'utf8');
  return { ok: true, spark: merged };
}

function transitionState(slug, sparkId, newState, opts) {
  _ensureSlug(slug);
  if (!sparkId || typeof sparkId !== 'string') {
    throw new SparkValidationError('sparkId required');
  }
  if (!newState || typeof newState !== 'string') {
    throw new SparkValidationError('newState required');
  }
  const current = getSpark(slug, sparkId);
  _assertTransitionLegal(current.state, newState);

  const ts = new Date().toISOString();
  const reason = (opts && typeof opts.reason === 'string') ? opts.reason : '';
  const transition = { from: current.state, to: newState, ts, reason };
  const updated = {
    ...current,
    state: newState,
    transitions: [...(current.transitions || []), transition],
  };
  fs.writeFileSync(_sparkPath(slug, sparkId), _renderSparkMd(updated), 'utf8');

  // Emit transition event — W3.5/W3.6 Companion subscribes here. Seed →
  // considered is the documented Companion "发芽表达" trigger; we mark it
  // explicitly so the listener doesn't have to diff states.
  if (_events && typeof _events.write === 'function') {
    try {
      _events.write(slug, {
        type: 'product:spark:transitioned',
        spark_id: sparkId,
        from: current.state,
        to: newState,
        reason,
        terminal: TERMINAL_STATES.includes(newState),
        // Companion hook flag — W3.6 reads this to decide whether to fire
        // the 发芽 (sprout) expression. intentional-placeholder: W3.6
        // Companion is out of W3.4 scope (per task brief "不动 W3.5 / W3.6
        // 文件"); we emit the typed flag now so when W3.6 lands it can
        // subscribe to events.jsonl without a schema change. Until W3.6
        // ships, this field is observed by no listener — the spark file
        // itself is the canonical record and remains useful standalone.
        companion_hook: (current.state === 'seed' && newState === 'considered')
          ? 'sprout' : null,
      });
    } catch (_) { /* see createSpark note */ }
  }

  return { ok: true, spark: updated, transition };
}

function archiveSpark(slug, sparkId) {
  _ensureSlug(slug);
  if (!sparkId || typeof sparkId !== 'string') {
    throw new SparkValidationError('sparkId required');
  }
  const src = _sparkPath(slug, sparkId);
  if (!fs.existsSync(src)) {
    throw new SparkNotFoundError(`spark '${sparkId}' not found in ${slug}`);
  }
  _ensureDir(_archiveDir(slug));
  const dst = _archivePath(slug, sparkId);
  // Preserve archive history if the user archived/un-archived/re-archived
  // by versioning the filename. Cheap, additive, never destructive.
  let finalDst = dst;
  if (fs.existsSync(dst)) {
    const base = dst.replace(/\.md$/, '');
    let n = 2;
    while (fs.existsSync(`${base}.v${n}.md`)) n += 1;
    finalDst = `${base}.v${n}.md`;
  }
  fs.renameSync(src, finalDst);

  if (_events && typeof _events.write === 'function') {
    try {
      _events.write(slug, {
        type: 'product:spark:archived',
        spark_id: sparkId,
        archive_path: finalDst,
      });
    } catch (_) { /* graceful */ }
  }
  return { ok: true, archive_path: finalDst };
}

// linkSparkToBlueprint — appends a row to inspiration-pool.jsonl so W3.2's
// Inspiration Pool section can render it. We do NOT call W3.2 directly;
// instead we use the W3.1-owned jsonl as a substrate. When W3.2 ships, it
// will read this file and re-render the blueprint Inspiration Pool §.
//
// If the slug has no bound product (no product/ dir), we still write the
// jsonl entry — creation-pool's bindProduct creates the dir on first call,
// but for unbound slugs this acts as a "deferred link" the user can claim
// later. We mkdir lazily so the call never fails on a fresh slug.
function linkSparkToBlueprint(slug, sparkId, blueprintSection) {
  _ensureSlug(slug);
  if (!sparkId || typeof sparkId !== 'string') {
    throw new SparkValidationError('sparkId required');
  }
  const spark = getSpark(slug, sparkId); // throws if missing
  const section = (typeof blueprintSection === 'string' && blueprintSection.trim())
    ? blueprintSection.trim()
    : 'inspiration_pool';

  const productDir = path.join(_vaultRoot(), slug, PRODUCT_LAYOUT.root_dir);
  _ensureDir(productDir);
  const poolPath = path.join(_vaultRoot(), slug, PRODUCT_LAYOUT.inspiration_pool);

  const row = {
    ts: new Date().toISOString(),
    source: 'product-spark',
    spark_id: sparkId,
    state: spark.state,
    blueprint_section: section,
    source_type: spark.source && spark.source.type,
    source_ref: spark.source && spark.source.ref,
    related_product: spark.related_product,
    core_transfer_preview: (spark.core_transfer || '').slice(0, 200),
  };
  fs.appendFileSync(poolPath, JSON.stringify(row) + '\n', 'utf8');

  if (_events && typeof _events.write === 'function') {
    try {
      _events.write(slug, {
        type: 'product:spark:linked_to_blueprint',
        spark_id: sparkId,
        blueprint_section: section,
      });
    } catch (_) { /* graceful */ }
  }

  return { ok: true, pool_path: poolPath, blueprint_section: section };
}

// =====================================================================
// Module exports
// =====================================================================

module.exports = {
  // CRUD
  createSpark,
  listSparks,
  getSpark,
  updateSpark,
  transitionState,
  archiveSpark,
  linkSparkToBlueprint,

  // Constants / shape (consumers can render UI from these)
  STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  SOURCE_TYPES,
  AFFECTED_MODULES_KNOWN,

  // Errors (so callers can `instanceof` narrow)
  SparkStateError,
  SparkValidationError,
  SparkNotFoundError,

  // Test surface — private helpers exposed under _internals so the test
  // file can exercise rendering / parsing without going through fs.
  _internals: {
    vaultRoot: _vaultRoot,
    sparksDir: _sparksDir,
    sparkPath: _sparkPath,
    archivePath: _archivePath,
    generateSparkId: _generateSparkId,
    renderSparkMd: _renderSparkMd,
    parseSparkMd: _parseSparkMd,
    hydrateFromFrontmatter: _hydrateFromFrontmatter,
    assertTransitionLegal: _assertTransitionLegal,
  },
};
