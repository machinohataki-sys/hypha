'use strict';

// HYPHA · Product Registry — vault-level Product Pool (BLUEPRINT §11.1).
//
// Per BLUEPRINT §11: 用户当前创造物的认知容器. Products are STANDALONE entities,
// not tied to any curriculum slug. A user can own multiple products simultaneously
// (HYPHA / 一本书 / 一篇论文 / 一个网站 ...). 任何课程的 Deepen / Lesson / Note
// 处理时, §11.3 Product Transfer 跨 product 扫并 surface "迁移到你的产品" 段。
//
// Storage layout:
//   vault/.products/<productId>/
//     meta.json            — {productId, name, type, northStar, createdAt, lastUpdated}
//     blueprint.md         — 10-section markdown (§11.2 template)
//     inspiration-pool.jsonl — cross-curriculum lesson/note/spark references
//
// Why .products/ (leading dot)?
//   curriculum:list (main.js:8193-8211) walks `vault/<top-level-dir>/state.json` and
//   skips `entries.startsWith('.')`. So `.products/` is invisible to the curriculum
//   list — it's a sibling namespace, not a course.
//
// This is W3.x-orthogonal: legacy `vault/<slug>/product/blueprint.md` (creation-pool.js)
// stays for curriculum-bound products; new product-registry.js handles the standalone
// product pool. v0.2 will migrate legacy products into .products/ via one-shot script.

const fs = require('node:fs');
const path = require('node:path');
const vault = require('./vault');

const REGISTRY_DIR_NAME = '.products';

// 10 product types — mirrors creation-pool-schema.js PRODUCT_TYPES for compat.
const PRODUCT_TYPES = Object.freeze([
  'product', 'thesis', 'novel', 'research', 'website',
  'course', 'personal_brand', 'opensource', 'business', 'exam_prep',
]);

// 10 sections per BLUEPRINT §11.2. Order is load-bearing (UI renders in this order).
const BLUEPRINT_SECTIONS = Object.freeze([
  { id: 'northStar',       title: 'Product North Star',   hint: '这个产品最终要改变什么？一句话写下它存在的理由。' },
  { id: 'targetUsers',     title: 'Target Users',         hint: '为谁存在？刻画 1-3 个具体的人。' },
  { id: 'corePain',        title: 'Core Pain',            hint: '解决什么痛点？痛点是用户当前正在承受的代价。' },
  { id: 'hypothesis',      title: 'Current Hypothesis',   hint: '当前最重要的产品假设 — 证伪则 pivot。' },
  { id: 'modules',         title: 'Modules',              hint: '已有模块: 名字 + 职责, 一行一个。' },
  { id: 'openQuestions',   title: 'Open Questions',       hint: '还没想清楚的问题, 写下即降低熵。' },
  { id: 'inspirationPool', title: 'Inspiration Pool',     hint: '从 Lesson / Note / Book / Pack 迁移来的灵感。' },
  { id: 'decisionLog',     title: 'Decision Log',         hint: '关键决策 — 时间 + 依据 + 反方。' },
  { id: 'riskMap',         title: 'Risk Map',             hint: '技术 / 商业 / 产品 / 法律 / 成本风险。' },
  { id: 'roadmap',         title: 'Roadmap',              hint: '从当前到理想的路径 — 叙事, 非甘特图。' },
]);

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function _registryRoot() {
  const root = vault.resolveRoot();
  const dir = path.join(root, REGISTRY_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _productDir(productId) {
  if (!productId || typeof productId !== 'string') {
    throw new Error('product-registry: productId required (non-empty string)');
  }
  if (productId.includes('/') || productId.includes('\\') || productId.includes('..') || productId.startsWith('.')) {
    throw new Error('product-registry: productId must be a single safe segment');
  }
  return path.join(_registryRoot(), productId);
}

function _safeProductId(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Slugify: keep CJK + ASCII alphanumeric, collapse other to hyphen, cap at 48.
  const slug = trimmed
    .replace(/[\s_.\\/]+/g, '-')
    .replace(/[^\p{L}\p{N}\-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!slug) return null;
  // Append timestamp to avoid collision when two products share a name.
  return `${slug}-${Date.now().toString(36)}`;
}

function _readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return null; }
}

function _safeWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Blueprint markdown renderer — 10 sections per §11.2.
// ---------------------------------------------------------------------------

function _renderBlueprintMd(meta) {
  const lines = [
    '---',
    `product_id: ${JSON.stringify(meta.productId)}`,
    `product_name: ${JSON.stringify(meta.name)}`,
    `product_type: ${JSON.stringify(meta.type)}`,
    `north_star: ${JSON.stringify(meta.northStar || '')}`,
    `created_at: ${JSON.stringify(meta.createdAt)}`,
    `last_updated: ${JSON.stringify(meta.lastUpdated || meta.createdAt)}`,
    `schema_version: 1`,
    '---',
    '',
    `# ${meta.name}`,
    '',
    `> **类型**: ${meta.type}  ·  **北极星**: ${meta.northStar || '(待填写)'}`,
    '',
    '_由 Product Registry 生成 (BLUEPRINT §11.2 十段模板)。各段内容由 Product Blueprint 编辑器填写, 或由 Deepen Transfer 自动追加 §7 灵感池。_',
    '',
  ];
  for (const sec of BLUEPRINT_SECTIONS) {
    lines.push(`## ${sec.title}`);
    lines.push('');
    lines.push(`<!-- section-id: ${sec.id} -->`);
    lines.push(`_${sec.hint}_`);
    lines.push('');
    lines.push('(待填写)');
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function listProducts() {
  const root = _registryRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const productId = entry.name;
    const metaPath = path.join(root, productId, 'meta.json');
    const meta = _readJsonSafe(metaPath);
    if (!meta) continue;
    out.push({
      productId,
      name: meta.name,
      type: meta.type,
      northStar: meta.northStar,
      createdAt: meta.createdAt,
      lastUpdated: meta.lastUpdated || meta.createdAt,
    });
  }
  // Sort: most-recently-updated first.
  out.sort((a, b) => String(b.lastUpdated).localeCompare(String(a.lastUpdated)));
  return out;
}

function createProduct({ name, type, northStar } = {}) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { ok: false, error: 'product-registry: name required' };
  }
  const resolvedType = type && PRODUCT_TYPES.includes(type) ? type : 'product';
  const productId = _safeProductId(name);
  if (!productId) {
    return { ok: false, error: 'product-registry: name could not be slugified' };
  }
  const dir = _productDir(productId);
  if (fs.existsSync(dir)) {
    return { ok: false, error: `product-registry: productId collision: ${productId}` };
  }
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const meta = {
    productId,
    name: name.trim(),
    type: resolvedType,
    northStar: (northStar || '').trim(),
    createdAt: now,
    lastUpdated: now,
  };
  _safeWriteJson(path.join(dir, 'meta.json'), meta);
  fs.writeFileSync(path.join(dir, 'blueprint.md'), _renderBlueprintMd(meta), 'utf8');
  fs.writeFileSync(path.join(dir, 'inspiration-pool.jsonl'), '', 'utf8');

  return { ok: true, product: meta };
}

function getProduct(productId) {
  const dir = _productDir(productId);
  if (!fs.existsSync(dir)) return null;
  const meta = _readJsonSafe(path.join(dir, 'meta.json'));
  if (!meta) return null;
  let blueprintMd = '';
  try { blueprintMd = fs.readFileSync(path.join(dir, 'blueprint.md'), 'utf8'); } catch (_) {}
  return { ...meta, blueprintMd };
}

function updateBlueprint(productId, blueprintMd) {
  if (typeof blueprintMd !== 'string') {
    return { ok: false, error: 'product-registry: blueprintMd must be string' };
  }
  const dir = _productDir(productId);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `product-registry: unknown productId: ${productId}` };
  }
  fs.writeFileSync(path.join(dir, 'blueprint.md'), blueprintMd, 'utf8');
  const metaPath = path.join(dir, 'meta.json');
  const meta = _readJsonSafe(metaPath);
  if (meta) {
    meta.lastUpdated = new Date().toISOString();
    _safeWriteJson(metaPath, meta);
  }
  return { ok: true };
}

// Append an inspiration row — used by Product Transfer (§11.3) when a lesson /
// note / spark crosses the relevance threshold against this product's blueprint.
function appendInspiration(productId, row) {
  const dir = _productDir(productId);
  if (!fs.existsSync(dir)) {
    return { ok: false, error: `product-registry: unknown productId: ${productId}` };
  }
  if (!row || typeof row !== 'object') {
    return { ok: false, error: 'product-registry: row must be object' };
  }
  const stamped = {
    ts: new Date().toISOString(),
    source: row.source || '',
    relevance: typeof row.relevance === 'number' ? row.relevance : null,
    source_summary: row.source_summary || '',
    ...(row.linked_section_id ? { linked_section_id: row.linked_section_id } : {}),
    ...(row.tags ? { tags: row.tags } : {}),
  };
  fs.appendFileSync(path.join(dir, 'inspiration-pool.jsonl'), JSON.stringify(stamped) + '\n', 'utf8');
  return { ok: true, row: stamped };
}

function listInspirations(productId, { limit } = {}) {
  const dir = _productDir(productId);
  if (!fs.existsSync(dir)) return [];
  const file = path.join(dir, 'inspiration-pool.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const rows = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return typeof limit === 'number' && limit > 0 ? rows.slice(0, limit) : rows;
}

module.exports = {
  PRODUCT_TYPES,
  BLUEPRINT_SECTIONS,
  listProducts,
  createProduct,
  getProduct,
  updateBlueprint,
  appendInspiration,
  listInspirations,
};
