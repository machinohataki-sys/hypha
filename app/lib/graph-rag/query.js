'use strict';

// HYPHA · GraphRAG · Query / Multi-Hop Retrieval (Phase B Gap 4).
//
// Pipeline:
//   1. LLM expand courseGoal → candidate entity list
//      e.g. "诺贝尔文学" → ["Mo Yan", "Kawabata", "Ishiguro", "Murakami", ...]
//   2. For each book's graph.json: lookup expanded entities against
//      node.name + node.aliases (case-insensitive, normalized).
//   3. Hit → 2-3 hop walk along edges (prerequisite/extends/explains/etc.)
//      collect reached nodes + their chunk indices.
//   4. Score hits:
//      direct entity match  → +10
//      walked via 1 hop     → +4
//      walked via 2 hops    → +1.5
//      community summary entity-hit → +3 (any node in same community)
//   5. Rank chunks by aggregate score, return top k with provenance.
//
// Honest gap: walk depth is hardcoded MAX_HOPS=3 — works for typical
// philosophy / literature / science graphs (50-300 nodes per book) but
// will need a per-archetype tuning pass once we have real-world graphs.

const fs = require('node:fs');
const path = require('node:path');

const LIBRARY_SUBDIR = 'data/library';
const MAX_HOPS = 3;
const HOP_WEIGHTS = [10, 4, 1.5, 0.5]; // index = hop number (0 = direct)
const COMMUNITY_BONUS = 3;
const DEFAULT_K = 10;
const MAX_EXPANSION_ENTITIES = 24;
const MAX_CHUNK_SNIPPET = 400;

function _safeReadJSON(absPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (_) { return null; }
}

function _normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
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

async function _expandGoal(courseGoal, archetype, settings) {
  let llm;
  try { llm = require('../llm'); } catch (_) { llm = null; }
  const exec = (settings && typeof settings._mockExecuteChat === 'function')
    ? settings._mockExecuteChat
    : (llm && llm.executeChat);

  if (!exec) {
    // No LLM available → split goal on whitespace + CJK chars as crude fallback
    const tokens = String(courseGoal || '').split(/[\s,;、，]+/).filter(Boolean);
    return { entities: tokens, themes: [] };
  }

  const sys = '你是 GraphRAG 查询扩展器. 把课程目标扩成可与书的实体图匹配的实体名列表.\n'
    + '输出 STRICT JSON: {"entities": ["<name>", ...], "themes": ["<broader topic>", ...]}\n'
    + '无 markdown, 无 prose.\n'
    + '- entities 最多 24 个, 优先具体: 人名 / 作品 / 学说 / 流派. 用最常见拼写, 双语都给(英文 + 中文/原文)\n'
    + '- themes 是更宽的主题词, 用于 community-summary 匹配, 最多 6 个\n'
    + '- 示例: courseGoal="诺贝尔文学" → entities=["Mo Yan","莫言","Kawabata Yasunari","川端康成","Kazuo Ishiguro","Gabriel García Márquez","Toni Morrison","Pearl Buck","Hemingway","Faulkner"], themes=["Nobel Prize literature","20th century novel","magical realism"]\n'
    + '- 示例: courseGoal="斯宾诺莎伦理学" → entities=["Spinoza","斯宾诺莎","Ethics","substance","conatus","Descartes","Leibniz"], themes=["rationalism","17th century metaphysics","monism"]';

  const usr = `courseGoal: ${courseGoal}\n`
    + (archetype ? `archetype: ${archetype}\n` : '')
    + '请输出 JSON.';

  try {
    const res = await exec('T3_MID', {
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: usr },
      ],
      json: true,
      maxTokens: 600,
      temperature: 0,
    });
    const txt = _extractTextFromLlmResult(res);
    const parsed = _safeJsonParse(txt);
    if (!parsed) return { entities: [], themes: [] };
    const entities = Array.isArray(parsed.entities) ? parsed.entities.slice(0, MAX_EXPANSION_ENTITIES) : [];
    const themes = Array.isArray(parsed.themes) ? parsed.themes.slice(0, 6) : [];
    return { entities, themes };
  } catch (_err) {
    return { entities: [], themes: [] };
  }
}

function _buildNodeIndex(graph) {
  // name (normalized) + each alias → node
  const index = new Map();
  for (const n of (graph.nodes || [])) {
    const keys = [n.name, ...(n.aliases || [])].filter(Boolean).map(_normName);
    for (const k of keys) {
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(n);
    }
  }
  return index;
}

function _buildAdjacency(graph) {
  // node_id → [{neighbor_id, type, evidence_chunks}]
  const adj = new Map();
  for (const n of (graph.nodes || [])) adj.set(n.id, []);
  for (const e of (graph.edges || [])) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from).push({ neighbor_id: e.to, type: e.type, evidence_chunks: e.evidence_chunks || [], direction: 'out' });
    adj.get(e.to).push({ neighbor_id: e.from, type: e.type, evidence_chunks: e.evidence_chunks || [], direction: 'in' });
  }
  return adj;
}

function _communityForNode(graph) {
  const out = new Map();
  for (const c of (graph.communities || [])) {
    for (const nid of (c.node_ids || [])) out.set(nid, c.community_id);
  }
  return out;
}

function _summaryByCommunity(graph) {
  const out = new Map();
  for (const s of (graph.community_summaries || [])) out.set(s.community_id, s.summary || '');
  return out;
}

function _walk({ adj, startNodeId, maxHops }) {
  // BFS up to maxHops. Returns Map<nodeId, {hop, pathEdges}>
  const seen = new Map();
  seen.set(startNodeId, { hop: 0, pathEdges: [] });
  let frontier = [startNodeId];
  for (let hop = 1; hop <= maxHops; hop++) {
    const next = [];
    for (const nid of frontier) {
      const edges = adj.get(nid) || [];
      for (const ed of edges) {
        if (seen.has(ed.neighbor_id)) continue;
        const prev = seen.get(nid);
        const pathEdges = prev.pathEdges.concat([{
          from: nid, to: ed.neighbor_id, type: ed.type, direction: ed.direction,
        }]);
        seen.set(ed.neighbor_id, { hop, pathEdges });
        next.push(ed.neighbor_id);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return seen;
}

function _scoreForHop(hop) {
  if (hop < 0) return 0;
  if (hop >= HOP_WEIGHTS.length) return HOP_WEIGHTS[HOP_WEIGHTS.length - 1] * 0.5;
  return HOP_WEIGHTS[hop];
}

function _themeMatchesSummary(summary, themes) {
  if (!summary || !themes || themes.length === 0) return false;
  const s = String(summary).toLowerCase();
  for (const t of themes) {
    if (!t || typeof t !== 'string') continue;
    if (s.includes(t.toLowerCase())) return true;
  }
  return false;
}

async function _queryOneBook({ graphPath, manifestPath, expansion }) {
  const graph = _safeReadJSON(graphPath);
  if (!graph || !Array.isArray(graph.nodes)) return [];
  const manifest = _safeReadJSON(manifestPath);
  const chunkById = new Map();
  if (manifest && Array.isArray(manifest.chunks)) {
    for (const c of manifest.chunks) chunkById.set(c.idx, c);
  }
  const nodeIndex = _buildNodeIndex(graph);
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const adj = _buildAdjacency(graph);
  const communityForNode = _communityForNode(graph);
  const summaryByCommunity = _summaryByCommunity(graph);

  // 1. Direct entity match — walk seed set
  const directHitNodes = new Map(); // node_id → matched_query_entity
  for (const ent of expansion.entities) {
    const key = _normName(ent);
    if (!key) continue;
    const matches = nodeIndex.get(key) || [];
    for (const m of matches) {
      if (!directHitNodes.has(m.id)) directHitNodes.set(m.id, ent);
    }
  }

  // 2. Walk from each direct hit, accumulate scored chunk hits
  // Key chunks by (book_id, chunk_idx) — different walks reaching same chunk
  // sum-bonus (Microsoft GraphRAG ranking pattern).
  const chunkScores = new Map(); // `${chunk_idx}` → {score, hits[]}

  function _addChunk(chunkIdx, scoreDelta, hitInfo) {
    if (!Number.isFinite(chunkIdx)) return;
    const k = String(chunkIdx);
    const prev = chunkScores.get(k);
    if (prev) {
      prev.score += scoreDelta;
      prev.hits.push(hitInfo);
    } else {
      chunkScores.set(k, { score: scoreDelta, hits: [hitInfo] });
    }
  }

  for (const [hitNodeId, queryEntity] of directHitNodes.entries()) {
    const reached = _walk({ adj, startNodeId: hitNodeId, maxHops: MAX_HOPS });
    for (const [reachedId, info] of reached.entries()) {
      const reachedNode = nodeById.get(reachedId);
      if (!reachedNode) continue;
      const score = _scoreForHop(info.hop);
      for (const chunkIdx of (reachedNode.chunk_idxs || [reachedNode.first_chunk_idx])) {
        _addChunk(chunkIdx, score, {
          hit_node_id: hitNodeId,
          hit_node_name: nodeById.get(hitNodeId) ? nodeById.get(hitNodeId).name : null,
          matched_query_entity: queryEntity,
          reached_node_id: reachedId,
          reached_node_name: reachedNode.name,
          hop: info.hop,
          walked_via: info.pathEdges,
        });
      }
    }
  }

  // 3. Community-summary theme bonus — boost any chunk owned by a node in a
  // community whose summary string contains any expanded theme.
  for (const node of graph.nodes) {
    const cid = communityForNode.get(node.id);
    if (cid == null) continue;
    const summary = summaryByCommunity.get(cid) || '';
    if (!_themeMatchesSummary(summary, expansion.themes)) continue;
    for (const chunkIdx of (node.chunk_idxs || [node.first_chunk_idx])) {
      _addChunk(chunkIdx, COMMUNITY_BONUS, {
        hit_node_id: null,
        matched_query_entity: '(community-theme)',
        reached_node_id: node.id,
        reached_node_name: node.name,
        hop: -1,
        walked_via: [],
        community_summary: summary,
      });
    }
  }

  if (chunkScores.size === 0) return [];

  const out = [];
  for (const [chunkIdxStr, info] of chunkScores.entries()) {
    const chunkIdx = parseInt(chunkIdxStr, 10);
    const ch = chunkById.get(chunkIdx);
    if (!ch) continue;
    // Pick the strongest hit (lowest hop) to surface as primary provenance
    info.hits.sort((a, b) => {
      const ha = a.hop < 0 ? 99 : a.hop;
      const hb = b.hop < 0 ? 99 : b.hop;
      return ha - hb;
    });
    const primary = info.hits[0];
    out.push({
      book_id: graph.book_id,
      book_title: graph.book_title || '',
      book_author: graph.book_author || '',
      chunk_idx: chunkIdx,
      chunk_title: ch.title || '',
      snippet: String(ch.text || '').slice(0, MAX_CHUNK_SNIPPET),
      score: info.score,
      hit_node: primary && primary.hit_node_name ? primary.hit_node_name : (primary && primary.reached_node_name),
      matched_query_entity: primary && primary.matched_query_entity,
      walked_via: primary && primary.walked_via || [],
      all_hits: info.hits.length,
    });
  }
  return out;
}

/**
 * Multi-hop graph retrieval across all book graphs in the library.
 *
 * @param {object} args
 * @param {string} args.courseGoal
 * @param {string} [args.archetype]
 * @param {number} [args.k=10]
 * @param {string} args.vaultRoot
 * @param {object} [args.settings]
 * @returns {Promise<Array>}
 */
async function runQuery(args = {}) {
  const { courseGoal, archetype, k, vaultRoot, settings } = args;
  if (!vaultRoot) return [];
  if (!courseGoal || !String(courseGoal).trim()) return [];
  const kCap = Number.isFinite(k) && k > 0 ? k : DEFAULT_K;

  const dir = path.join(vaultRoot, LIBRARY_SUBDIR);
  if (!fs.existsSync(dir)) return [];

  const expansion = await _expandGoal(courseGoal, archetype, settings);
  // If LLM expansion produced nothing usable, downgrade to raw split tokens
  // so a graph-aware search still works for keyword-style goals.
  if ((!expansion.entities || expansion.entities.length === 0) &&
      (!expansion.themes || expansion.themes.length === 0)) {
    const tokens = String(courseGoal).split(/[\s,;、，]+/).filter(Boolean);
    expansion.entities = tokens;
  }

  const allHits = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.graph.json')) continue;
    const bookId = ent.name.replace(/\.graph\.json$/, '');
    const graphPath = path.join(dir, ent.name);
    const manifestPath = path.join(dir, bookId + '.json');
    const hits = await _queryOneBook({ graphPath, manifestPath, expansion });
    for (const h of hits) allHits.push(h);
  }

  // Rank: aggregate score desc, tiebreak by book then chunk
  allHits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.book_id !== b.book_id) return a.book_id < b.book_id ? -1 : 1;
    return a.chunk_idx - b.chunk_idx;
  });

  return allHits.slice(0, kCap);
}

module.exports = {
  runQuery,
  MAX_HOPS,
};
