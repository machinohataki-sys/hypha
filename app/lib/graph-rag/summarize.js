'use strict';

// HYPHA · GraphRAG · Per-Community Summaries (Phase B Gap 4).
//
// Each Louvain community gets one-line LLM summary. Surfaces the thematic
// label ("Nobel-era novelists who broke realist convention") that the raw
// node names alone (Kawabata / Ishiguro / Garcia Marquez) need a reader
// to recognize. Used by queryGraph to rank community matches against the
// LLM-expanded courseGoal entity set.

const MAX_NODES_PREVIEW = 12;
const MAX_CHUNK_SNIPPET = 160;

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

/**
 * Generate a one-line summary for each community.
 *
 * @param {object} args
 * @param {Array} args.communities  [{community_id, node_ids}]
 * @param {Array} args.nodes        [{id, name, type, ...}]
 * @param {object} args.manifest    book manifest (for chunk snippets)
 * @param {object} [args.settings]
 * @returns {Promise<Array<{community_id, summary, top_nodes}>>}
 */
async function summarizeCommunities({ communities, nodes, manifest, settings }) {
  if (!Array.isArray(communities) || communities.length === 0) return [];

  let llm;
  try { llm = require('../llm'); } catch (_) { llm = null; }
  const exec = (settings && typeof settings._mockExecuteChat === 'function')
    ? settings._mockExecuteChat
    : (llm && llm.executeChat);

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const chunkById = new Map();
  if (manifest && Array.isArray(manifest.chunks)) {
    for (const c of manifest.chunks) chunkById.set(c.idx, c);
  }

  const out = [];
  for (const c of communities) {
    const memberNodes = c.node_ids.slice(0, MAX_NODES_PREVIEW)
      .map(id => nodeById.get(id))
      .filter(Boolean);
    if (memberNodes.length === 0) {
      out.push({ community_id: c.community_id, summary: '', top_nodes: c.node_ids.slice(0, 5) });
      continue;
    }
    // Tiny community (1-2 nodes) → skip LLM, just concat names
    if (memberNodes.length <= 2) {
      const summary = memberNodes.map(n => n.name).join(' / ');
      out.push({
        community_id: c.community_id,
        summary,
        top_nodes: memberNodes.map(n => n.id),
      });
      continue;
    }

    // Heavier community: ask LLM for a thematic label
    if (!exec) {
      out.push({
        community_id: c.community_id,
        summary: memberNodes.slice(0, 3).map(n => n.name).join(' / '),
        top_nodes: memberNodes.map(n => n.id),
      });
      continue;
    }

    const nodesLine = memberNodes
      .map(n => `${n.name} [${n.type}]`)
      .join(', ');
    const sampleChunkIdx = memberNodes[0].first_chunk_idx;
    const sampleChunk = chunkById.get(sampleChunkIdx);
    const sampleText = sampleChunk
      ? String(sampleChunk.text || '').slice(0, MAX_CHUNK_SNIPPET)
      : '';

    const sys = '你为一组语义相关的实体写一句话主题摘要 (≤30 字). '
      + '输出 STRICT JSON: {"summary":"<一句话>"} — 无 markdown, 无 prose.';
    const usr = `实体组: ${nodesLine}\n`
      + (sampleText ? `来源片段示例: ${sampleText}\n` : '')
      + '请用 ≤30 字概括这组实体共同代表什么主题 / 流派 / 时代。';

    try {
      const res = await exec('T3_MID', {
        messages: [
          { role: 'system', content: sys },
          { role: 'user',   content: usr },
        ],
        json: true,
        maxTokens: 200,
        temperature: 0,
      });
      const txt = _extractTextFromLlmResult(res);
      const parsed = _safeJsonParse(txt);
      const summary = (parsed && typeof parsed.summary === 'string' && parsed.summary.trim())
        ? parsed.summary.trim()
        : memberNodes.slice(0, 3).map(n => n.name).join(' / ');
      out.push({
        community_id: c.community_id,
        summary,
        top_nodes: memberNodes.map(n => n.id),
      });
    } catch (_err) {
      out.push({
        community_id: c.community_id,
        summary: memberNodes.slice(0, 3).map(n => n.name).join(' / '),
        top_nodes: memberNodes.map(n => n.id),
      });
    }
  }
  return out;
}

module.exports = {
  summarizeCommunities,
};
