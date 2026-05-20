'use strict';

// HYPHA · GraphRAG · Entity + Relationship Extraction (Phase B Gap 4).
//
// LazyGraphRAG-inspired: skip per-chunk summarization (the expensive step in
// Microsoft's original GraphRAG paper). Instead batch 5 chunks per LLM call,
// extract entities + relationships in a single JSON pass, dedupe across the
// book.
//
// Entity types:
//   person   — author / philosopher / scientist / literary figure
//   concept  — proposition / theorem / theory / argument
//   school   — movement / tradition / discipline
//   era      — period / century / decade
//   term     — domain-specific keyword (e.g. "phenomenology", "酬恩")
//   work     — book / paper / treatise (cross-reference to other works)
//   place    — geographic anchor when domain-relevant (Athens, Königsberg)
//
// Edge types: reuses the 13 typed edges from web-note-engine/types.js verbatim
// so downstream traversal logic can later unify book-graph + note-graph walks.

const { EDGE_TYPES } = require('../web-note-engine/types');

// Entity type whitelist — kept distinct from web-note-engine NODE_LAYERS
// (which is about note lifecycle). Books carry semantic-type entities.
const ENTITY_TYPES = Object.freeze([
  'person', 'concept', 'school', 'era', 'term', 'work', 'place',
]);

const BATCH_SIZE = 5;
const MAX_TOKENS_PER_BATCH = 1200;
const MAX_CHUNK_TEXT_CHARS = 1400;

function _normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function _truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function _extractTextFromLlmResult(res) {
  if (!res) return '';
  const r = res.result || res;
  if (typeof r === 'string') return r;
  if (r && typeof r.content === 'string') return r.content;
  if (r && typeof r.text === 'string') return r.text;
  if (r && r.message && typeof r.message.content === 'string') return r.message.content;
  if (r && Array.isArray(r.choices) && r.choices[0]
      && r.choices[0].message && typeof r.choices[0].message.content === 'string') {
    return r.choices[0].message.content;
  }
  return '';
}

function _safeJsonParse(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { return null; } }
  return null;
}

function _buildBatchPrompt(chunks) {
  const blocks = chunks.map(ch => {
    const title = ch.title || `Section ${ch.idx + 1}`;
    const text = _truncate(ch.text, MAX_CHUNK_TEXT_CHARS);
    return `[chunk_idx=${ch.idx}] ${title}\n${text}`;
  }).join('\n\n---\n\n');

  const sys = '你是 GraphRAG 抽取器. 从书的章节文本中抽出语义骨架:\n'
    + '1. entities — 人名 / 概念 / 流派 / 时代 / 关键术语 / 作品 / 地点\n'
    + '2. relationships — 实体之间的有向关系, 用 13 种 typed edge 之一\n\n'
    + 'entity type 枚举: ' + ENTITY_TYPES.join(' | ') + '\n'
    + 'edge type 枚举: ' + EDGE_TYPES.join(' | ') + '\n\n'
    + '输出 STRICT JSON, 无 markdown 围栏, 无 prose, 形如:\n'
    + '{\n'
    + '  "entities": [\n'
    + '    {"name": "Plato", "type": "person", "aliases": ["柏拉图"], "chunk_idx": 0}\n'
    + '  ],\n'
    + '  "relationships": [\n'
    + '    {"from": "Plato", "to": "Aristotle", "type": "prerequisite", "evidence_chunk": 0}\n'
    + '  ]\n'
    + '}\n\n'
    + '规则:\n'
    + '- name 用文本中出现的最常见拼写 (人名优先用本名, 不用别名作主键)\n'
    + '- aliases 收所有别名 / 译名 / 缩写\n'
    + '- 每 entity 必须带 chunk_idx (来源章节, 多个来源时取最早出现的)\n'
    + '- relationship.from / to 必须是 entities 中出现的 name (大小写匹配)\n'
    + '- evidence_chunk 必填, 写关系最先出现的 chunk_idx\n'
    + '- 不发明文本中没有的关系. 宁少勿多.\n'
    + '- 每批最多 25 个 entity + 20 个 relationship.';

  const usr = `从以下章节抽取:\n\n${blocks}`;

  return { sys, usr };
}

async function _runBatch(chunks, settings) {
  // Lazy require to avoid circular boot
  let llm;
  try { llm = require('../llm'); } catch (_) { llm = null; }
  if (!llm || typeof llm.executeChat !== 'function') {
    return { entities: [], relationships: [], cost_usd: 0 };
  }

  const { sys, usr } = _buildBatchPrompt(chunks);

  // settings._mockExecuteChat lets the smoke harness inject deterministic
  // responses without touching the real router.
  const exec = (settings && typeof settings._mockExecuteChat === 'function')
    ? settings._mockExecuteChat
    : llm.executeChat;

  let res;
  try {
    res = await exec('T3_MID', {
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: usr },
      ],
      json: true,
      maxTokens: MAX_TOKENS_PER_BATCH,
      temperature: 0,
    });
  } catch (err) {
    return { entities: [], relationships: [], cost_usd: 0, error: err && err.message };
  }
  const txt = _extractTextFromLlmResult(res);
  const parsed = _safeJsonParse(txt);
  if (!parsed) return { entities: [], relationships: [], cost_usd: 0 };
  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const relationships = Array.isArray(parsed.relationships) ? parsed.relationships : [];
  // Cost estimate: T3 GLM-4.5-Air ~ ¥0.0008 per 1k input + ¥0.0024 per 1k output
  // (USD ≈ ¥*0.14). Rough: input ~ 4000 chars / 1k = 4 units, output ~ 1k tokens.
  // Per batch: ~ ¥0.0056 ≈ $0.0008. Surfaced as estimate only.
  const cost_usd = 0.0008;
  return { entities, relationships, cost_usd };
}

/**
 * Extract a book-level entity+edge graph from its chunk array.
 *
 * @param {object} args
 * @param {object} args.manifest    book manifest with chunks[]
 * @param {object} [args.settings]
 * @param {function} [args.onProgress] (subStage, payload) => void
 * @returns {Promise<{nodes, edges, llm_calls, cost_usd_estimate}>}
 */
async function extractEntitiesAndEdges({ manifest, settings, onProgress }) {
  const emit = typeof onProgress === 'function' ? onProgress : () => {};
  if (!manifest || !Array.isArray(manifest.chunks)) {
    return { nodes: [], edges: [], llm_calls: 0, cost_usd_estimate: 0 };
  }
  const chunks = manifest.chunks;
  const entityByKey = new Map();   // normName → node draft
  const edgeKeys = new Set();
  const edges = [];
  let llmCalls = 0;
  let totalCost = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    emit('batch', { batchIdx: Math.floor(i / BATCH_SIZE), batchCount: Math.ceil(chunks.length / BATCH_SIZE) });
    const result = await _runBatch(batch, settings);
    llmCalls++;
    totalCost += result.cost_usd || 0;

    // Dedupe entities by normalized name. Merge aliases + record chunk_idx.
    for (const e of result.entities) {
      const name = String(e && e.name || '').trim();
      if (!name) continue;
      const type = ENTITY_TYPES.includes(e.type) ? e.type : 'term';
      const aliases = Array.isArray(e.aliases) ? e.aliases.filter(a => typeof a === 'string') : [];
      const chunkIdx = Number.isFinite(e.chunk_idx) ? e.chunk_idx : (batch[0] && batch[0].idx) || 0;
      const key = _normName(name);
      let node = entityByKey.get(key);
      if (!node) {
        node = {
          id: 'n_' + entityByKey.size + '_' + key.replace(/[^a-z0-9一-鿿]+/g, '_').slice(0, 32),
          name,
          type,
          aliases: [...new Set(aliases.map(a => a.trim()).filter(Boolean))],
          first_chunk_idx: chunkIdx,
          chunk_idxs: [chunkIdx],
        };
        entityByKey.set(key, node);
      } else {
        const newAliases = aliases.filter(a => a && !node.aliases.includes(a));
        if (newAliases.length) node.aliases = node.aliases.concat(newAliases);
        if (!node.chunk_idxs.includes(chunkIdx)) node.chunk_idxs.push(chunkIdx);
      }
    }

    // Edges: validate from/to map to existing nodes; dedupe by (from,to,type).
    for (const r of result.relationships) {
      if (!r || !r.from || !r.to || !r.type) continue;
      if (!EDGE_TYPES.includes(r.type)) continue;
      const fromKey = _normName(r.from);
      const toKey = _normName(r.to);
      const fromNode = entityByKey.get(fromKey);
      const toNode = entityByKey.get(toKey);
      if (!fromNode || !toNode) continue;
      if (fromNode.id === toNode.id) continue;
      const ekey = `${fromNode.id}::${r.type}::${toNode.id}`;
      const evidenceChunk = Number.isFinite(r.evidence_chunk) ? r.evidence_chunk
        : (batch[0] && batch[0].idx) || 0;
      if (edgeKeys.has(ekey)) {
        // Append additional evidence
        const existing = edges.find(x => x._key === ekey);
        if (existing && !existing.evidence_chunks.includes(evidenceChunk)) {
          existing.evidence_chunks.push(evidenceChunk);
        }
        continue;
      }
      edgeKeys.add(ekey);
      edges.push({
        _key: ekey,
        from: fromNode.id,
        to: toNode.id,
        type: r.type,
        evidence_chunks: [evidenceChunk],
      });
    }
  }

  // Strip internal _key field before persisting
  const cleanEdges = edges.map(e => ({
    from: e.from, to: e.to, type: e.type, evidence_chunks: e.evidence_chunks,
  }));

  return {
    nodes: [...entityByKey.values()],
    edges: cleanEdges,
    llm_calls: llmCalls,
    cost_usd_estimate: totalCost,
  };
}

module.exports = {
  extractEntitiesAndEdges,
  ENTITY_TYPES,
  BATCH_SIZE,
};
