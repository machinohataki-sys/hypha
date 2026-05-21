'use strict';

// HYPHA · GraphRAG smoke test — end-to-end build + query verification.
//
// Mocks executeChat with deterministic JSON so the test runs offline without
// real provider keys. Validates:
//   - buildGraph emits a well-formed graph.json sidecar
//   - queryGraph routes "诺贝尔文学" to the Kawabata book, NOT Copleston
//     (this is the user-caught BM25 regression — verifies CJK tokenizer
//     collapse is cured by graph-aware retrieval)
//   - queryGraph routes "斯宾诺莎伦理学" to Copleston, NOT Kawabata
//
// Run:  node app/scripts/_dev_verify_graph_rag.js
// Pass: prints "PASS N/N"; non-zero exit code on any failure.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Use a temp vault root so we don't touch the user's real vault
const TMP_ROOT = path.join(os.tmpdir(), 'hypha-graph-rag-smoke-' + Date.now());
const LIBRARY_DIR = path.join(TMP_ROOT, 'data', 'library');
fs.mkdirSync(LIBRARY_DIR, { recursive: true });

// Inject our temp root into vault.resolveRoot so graph-rag picks it up via
// the same path the agent does. We use HYPHA_VAULT_ROOT env var which
// vault.js honors at process start.
process.env.HYPHA_VAULT_ROOT = TMP_ROOT;

// --- Fixture books -----------------------------------------------------

const copleston = {
  id: 'copleston01',
  title: 'A History of Philosophy Vol IV — Descartes to Leibniz',
  author: 'Frederick Copleston',
  type: 'pdf',
  added_at: new Date().toISOString(),
  source_file_name: 'copleston-v4.pdf',
  page_count: 400,
  char_count: 12000,
  chunks: [
    { idx: 0, title: 'Descartes\' Method', text: '笛卡尔从普遍怀疑出发, 推出我思故我在. He sought certain foundations for science.', startCharIdx: 0 },
    { idx: 1, title: 'Spinoza on Substance', text: '斯宾诺莎 认为 substance 唯一无限, 神即自然. Ethics demonstrated more geometrico.', startCharIdx: 1000 },
    { idx: 2, title: 'Spinoza Ethics Part III', text: 'conatus 即每物努力保持自身存在的力. 情感作为身体的 affection.', startCharIdx: 2000 },
    { idx: 3, title: 'Leibniz Monadology', text: 'Leibniz 莱布尼茨 提出 monad 单子学说, 反对 Spinoza substance monism.', startCharIdx: 3000 },
    { idx: 4, title: 'Rationalist Legacy', text: '理性主义传统通过 Descartes Spinoza Leibniz 三人继承, 与英国经验论对峙.', startCharIdx: 4000 },
  ],
};

const kawabata = {
  id: 'kawabata01',
  title: '川端康成 文学序章 — Nobel Lecture and Selected Essays',
  author: 'Yasunari Kawabata',
  type: 'pdf',
  added_at: new Date().toISOString(),
  source_file_name: 'kawabata-nobel.pdf',
  page_count: 200,
  char_count: 8000,
  chunks: [
    { idx: 0, title: 'Nobel Acceptance 1968', text: '川端康成 1968 年获诺贝尔文学奖. Kawabata 引述美的日本的我.', startCharIdx: 0 },
    { idx: 1, title: 'Snow Country', text: '雪国 是 川端 代表作之一, 描写艺伎驹子与岛村的情感.', startCharIdx: 1000 },
    { idx: 2, title: 'Mishima\'s Counter', text: '三岛由纪夫 Mishima Yukio 反对川端的静观美学, 主张行动者文学.', startCharIdx: 2000 },
    { idx: 3, title: 'Nobel Literature 1968', text: 'Nobel Prize 1968 颁给川端, 表彰他对日本心灵本质的叙事力.', startCharIdx: 3000 },
    { idx: 4, title: 'Tradition of Mono no Aware', text: '物哀 mono no aware 是 川端 美学的核心, 上溯源氏物语.', startCharIdx: 4000 },
  ],
};

fs.writeFileSync(path.join(LIBRARY_DIR, copleston.id + '.json'), JSON.stringify(copleston, null, 2));
fs.writeFileSync(path.join(LIBRARY_DIR, copleston.id + '.txt'), copleston.chunks.map(c => c.text).join('\n'));
fs.writeFileSync(path.join(LIBRARY_DIR, kawabata.id + '.json'), JSON.stringify(kawabata, null, 2));
fs.writeFileSync(path.join(LIBRARY_DIR, kawabata.id + '.txt'), kawabata.chunks.map(c => c.text).join('\n'));

// --- Mock LLM responses ------------------------------------------------

const EXTRACTION_RESPONSES = {
  copleston01: [
    {
      // Batch 0: chunks 0-4 (BATCH_SIZE=5)
      entities: [
        { name: 'Descartes',  type: 'person', aliases: ['笛卡尔', 'René Descartes'], chunk_idx: 0 },
        { name: 'Spinoza',    type: 'person', aliases: ['斯宾诺莎', 'Baruch Spinoza'], chunk_idx: 1 },
        { name: 'Leibniz',    type: 'person', aliases: ['莱布尼茨'], chunk_idx: 3 },
        { name: 'substance',  type: 'concept', aliases: ['实体'], chunk_idx: 1 },
        { name: 'conatus',    type: 'concept', aliases: [], chunk_idx: 2 },
        { name: 'monad',      type: 'concept', aliases: ['单子'], chunk_idx: 3 },
        { name: 'Ethics',     type: 'work',   aliases: ['伦理学'], chunk_idx: 1 },
        { name: 'rationalism', type: 'school', aliases: ['理性主义'], chunk_idx: 4 },
      ],
      relationships: [
        { from: 'Descartes', to: 'Spinoza',    type: 'prerequisite', evidence_chunk: 0 },
        { from: 'Spinoza',   to: 'substance',  type: 'explains',     evidence_chunk: 1 },
        { from: 'Spinoza',   to: 'Ethics',     type: 'productizes',  evidence_chunk: 1 },
        { from: 'Spinoza',   to: 'conatus',    type: 'explains',     evidence_chunk: 2 },
        { from: 'Leibniz',   to: 'monad',      type: 'explains',     evidence_chunk: 3 },
        { from: 'Leibniz',   to: 'Spinoza',    type: 'contradicts',  evidence_chunk: 3 },
        { from: 'rationalism', to: 'Descartes', type: 'example_of', evidence_chunk: 4 },
        { from: 'rationalism', to: 'Spinoza',   type: 'example_of', evidence_chunk: 4 },
        { from: 'rationalism', to: 'Leibniz',   type: 'example_of', evidence_chunk: 4 },
      ],
    },
  ],
  kawabata01: [
    {
      entities: [
        { name: 'Kawabata Yasunari', type: 'person', aliases: ['川端康成', 'Kawabata'], chunk_idx: 0 },
        { name: 'Nobel Prize',       type: 'concept', aliases: ['诺贝尔奖', '诺贝尔文学奖'], chunk_idx: 0 },
        { name: 'Snow Country',      type: 'work',   aliases: ['雪国'], chunk_idx: 1 },
        { name: 'Mishima Yukio',     type: 'person', aliases: ['三岛由纪夫'], chunk_idx: 2 },
        { name: 'mono no aware',     type: 'concept', aliases: ['物哀'], chunk_idx: 4 },
        { name: 'Genji Monogatari',  type: 'work',   aliases: ['源氏物语'], chunk_idx: 4 },
        { name: 'Japanese aesthetic', type: 'school', aliases: ['日本美学'], chunk_idx: 0 },
      ],
      relationships: [
        { from: 'Kawabata Yasunari', to: 'Nobel Prize',  type: 'decides',      evidence_chunk: 0 },
        { from: 'Kawabata Yasunari', to: 'Snow Country', type: 'productizes',  evidence_chunk: 1 },
        { from: 'Mishima Yukio',     to: 'Kawabata Yasunari', type: 'contradicts', evidence_chunk: 2 },
        { from: 'Kawabata Yasunari', to: 'mono no aware', type: 'explains',    evidence_chunk: 4 },
        { from: 'mono no aware',     to: 'Genji Monogatari', type: 'extends', evidence_chunk: 4 },
        { from: 'Japanese aesthetic', to: 'mono no aware', type: 'example_of', evidence_chunk: 4 },
        { from: 'Japanese aesthetic', to: 'Kawabata Yasunari', type: 'applies_to', evidence_chunk: 0 },
      ],
    },
  ],
};

const SUMMARY_RESPONSES = {
  // Keyed by sorted entity names — community summarizer asks LLM with a
  // node list. We pattern-match against contents.
  copleston01: '17 世纪欧陆理性主义形而上学',
  kawabata01: '日本诺贝尔获奖文学与物哀传统',
};

const QUERY_EXPANSIONS = {
  '诺贝尔文学': {
    entities: ['Kawabata Yasunari', '川端康成', 'Mishima Yukio', 'Nobel Prize', 'Snow Country', '诺贝尔文学奖'],
    themes: ['Nobel literature', 'Japanese literature', 'mono no aware'],
  },
  '斯宾诺莎伦理学': {
    entities: ['Spinoza', '斯宾诺莎', 'Ethics', 'substance', 'conatus', 'Descartes', 'Leibniz'],
    themes: ['rationalism', '17th century metaphysics', 'monism'],
  },
};

let extractionCallCount = 0;
let summarizeCallCount = 0;
let expansionCallCount = 0;

function _makeMockExecute(bookIdHint) {
  return async function mockExecuteChat(capability, args) {
    const usrMsg = (args.messages || []).find(m => m.role === 'user');
    const sysMsg = (args.messages || []).find(m => m.role === 'system');
    const userContent = String(usrMsg && usrMsg.content || '');
    const sysContent = String(sysMsg && sysMsg.content || '');

    // Extraction prompt path
    if (sysContent.includes('GraphRAG 抽取器')) {
      extractionCallCount++;
      const responses = EXTRACTION_RESPONSES[bookIdHint] || [{ entities: [], relationships: [] }];
      const r = responses.shift() || { entities: [], relationships: [] };
      return { result: JSON.stringify(r), providerId: 'mock', model: 'mock', capability, attempts: 1 };
    }
    // Summary prompt path
    if (sysContent.includes('实体写一句话主题摘要') || sysContent.includes('实体组')) {
      summarizeCallCount++;
      const out = { summary: SUMMARY_RESPONSES[bookIdHint] || 'mixed cluster' };
      return { result: JSON.stringify(out), providerId: 'mock', model: 'mock', capability, attempts: 1 };
    }
    // Query expansion path
    if (sysContent.includes('GraphRAG 查询扩展器')) {
      expansionCallCount++;
      for (const goal of Object.keys(QUERY_EXPANSIONS)) {
        if (userContent.includes(goal)) {
          return { result: JSON.stringify(QUERY_EXPANSIONS[goal]), providerId: 'mock', model: 'mock', capability, attempts: 1 };
        }
      }
      return { result: JSON.stringify({ entities: [], themes: [] }), providerId: 'mock', model: 'mock', capability, attempts: 1 };
    }
    return { result: '{}', providerId: 'mock', model: 'mock', capability, attempts: 1 };
  };
}

// --- Test harness ------------------------------------------------------

let passed = 0;
let total = 0;
const failures = [];

function assert(cond, label, detail) {
  total++;
  if (cond) {
    passed++;
    console.log(`  [PASS] ${label}`);
  } else {
    failures.push({ label, detail });
    console.error(`  [FAIL] ${label}${detail ? ' :: ' + JSON.stringify(detail).slice(0, 240) : ''}`);
  }
}

(async function main() {
  console.log('=== HYPHA GraphRAG smoke test ===');
  console.log('tmp vault root:', TMP_ROOT);

  const graphRag = require('../lib/graph-rag');

  // ── Test 1: buildGraph for Copleston ──────────────────────────────
  console.log('\n[1] buildGraph(copleston01)');
  const r1 = await graphRag.buildGraph(copleston.id, {
    vaultRoot: TMP_ROOT,
    settings: { _mockExecuteChat: _makeMockExecute(copleston.id) },
  });
  assert(r1 && r1.ok, 'buildGraph copleston returns ok', r1);
  assert(fs.existsSync(graphRag.getGraphPath(TMP_ROOT, copleston.id)), 'graph.json written for copleston');
  const cGraph = JSON.parse(fs.readFileSync(graphRag.getGraphPath(TMP_ROOT, copleston.id), 'utf8'));
  assert(cGraph.nodes.length >= 6, 'copleston graph has >=6 nodes', { nodeCount: cGraph.nodes.length });
  assert(cGraph.edges.length >= 5, 'copleston graph has >=5 edges', { edgeCount: cGraph.edges.length });
  assert(cGraph.communities && cGraph.communities.length >= 1, 'copleston has >=1 community');
  const spinozaNode = cGraph.nodes.find(n => n.name === 'Spinoza');
  assert(spinozaNode != null, 'Spinoza node present in copleston graph');
  assert(spinozaNode && Array.isArray(spinozaNode.aliases) && spinozaNode.aliases.includes('斯宾诺莎'),
    'Spinoza aliases include 斯宾诺莎');

  // ── Test 2: buildGraph for Kawabata ───────────────────────────────
  console.log('\n[2] buildGraph(kawabata01)');
  const r2 = await graphRag.buildGraph(kawabata.id, {
    vaultRoot: TMP_ROOT,
    settings: { _mockExecuteChat: _makeMockExecute(kawabata.id) },
  });
  assert(r2 && r2.ok, 'buildGraph kawabata returns ok', r2);
  const kGraph = JSON.parse(fs.readFileSync(graphRag.getGraphPath(TMP_ROOT, kawabata.id), 'utf8'));
  assert(kGraph.nodes.length >= 6, 'kawabata graph has >=6 nodes', { nodeCount: kGraph.nodes.length });
  const kawabataNode = kGraph.nodes.find(n => n.name === 'Kawabata Yasunari');
  assert(kawabataNode != null, 'Kawabata node present in kawabata graph');
  assert(kawabataNode && kawabataNode.aliases.includes('川端康成'),
    'Kawabata aliases include 川端康成');

  // ── Test 3: queryGraph("诺贝尔文学") → Kawabata, NOT Copleston ──
  console.log('\n[3] queryGraph("诺贝尔文学") — false-positive check');
  const hits1 = await graphRag.queryGraph({
    courseGoal: '诺贝尔文学',
    k: 10,
    vaultRoot: TMP_ROOT,
    settings: { _mockExecuteChat: _makeMockExecute(null) },
  });
  assert(Array.isArray(hits1) && hits1.length > 0, '诺贝尔文学 returns hits', { count: hits1.length });
  const kawabataHits = hits1.filter(h => h.book_id === kawabata.id);
  const coplestonHits = hits1.filter(h => h.book_id === copleston.id);
  assert(kawabataHits.length > 0, '诺贝尔文学 returns ≥1 Kawabata chunk',
    { kawabata_n: kawabataHits.length, copleston_n: coplestonHits.length });
  assert(coplestonHits.length === 0, '诺贝尔文学 returns 0 Copleston chunks (false-positive cured)',
    { copleston_hits: coplestonHits });
  // Highest-score hit should be a Kawabata one
  if (hits1.length > 0) {
    assert(hits1[0].book_id === kawabata.id, 'top hit is Kawabata',
      { top_book: hits1[0].book_id, top_score: hits1[0].score });
  }

  // ── Test 4: queryGraph("斯宾诺莎伦理学") → Copleston ────────────
  console.log('\n[4] queryGraph("斯宾诺莎伦理学") — positive control');
  const hits2 = await graphRag.queryGraph({
    courseGoal: '斯宾诺莎伦理学',
    k: 10,
    vaultRoot: TMP_ROOT,
    settings: { _mockExecuteChat: _makeMockExecute(null) },
  });
  assert(Array.isArray(hits2) && hits2.length > 0, '斯宾诺莎伦理学 returns hits', { count: hits2.length });
  const cHits2 = hits2.filter(h => h.book_id === copleston.id);
  const kHits2 = hits2.filter(h => h.book_id === kawabata.id);
  assert(cHits2.length > 0, '斯宾诺莎伦理学 returns ≥1 Copleston chunk',
    { copleston_n: cHits2.length, kawabata_n: kHits2.length });
  if (hits2.length > 0) {
    assert(hits2[0].book_id === copleston.id, 'top hit is Copleston',
      { top_book: hits2[0].book_id, top_score: hits2[0].score });
  }
  // Verify provenance trail is populated
  if (hits2.length > 0 && hits2[0].book_id === copleston.id) {
    const top = hits2[0];
    assert(top.hit_node != null, 'top hit carries hit_node provenance', { hit_node: top.hit_node });
    assert(Array.isArray(top.walked_via), 'top hit carries walked_via array',
      { walked_via_len: top.walked_via.length });
  }

  // ── Test 5: schema shape ─────────────────────────────────────────
  console.log('\n[5] graph.json schema sanity');
  assert(typeof cGraph.book_id === 'string', 'graph.book_id is string');
  assert(typeof cGraph.version === 'number', 'graph.version is number');
  assert(typeof cGraph.extracted_at === 'string', 'graph.extracted_at is iso string');
  assert(cGraph.stats && typeof cGraph.stats.node_count === 'number', 'graph.stats.node_count is number');
  assert(Array.isArray(cGraph.community_summaries), 'graph.community_summaries is array');

  // ── Summary ──────────────────────────────────────────────────────
  console.log('\n=== Mock LLM call counts ===');
  console.log(`  extraction:  ${extractionCallCount} (expected ≥ 2 — 1 per book × 2 books)`);
  console.log(`  summarize:   ${summarizeCallCount}`);
  console.log(`  expansion:   ${expansionCallCount} (expected 2 — 1 per query)`);

  console.log('\n=== Result ===');
  console.log(`PASS ${passed}/${total}`);
  if (failures.length > 0) {
    console.error('Failures:');
    for (const f of failures) console.error(`  - ${f.label}`);
    process.exit(1);
  }

  // Clean up temp vault
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
})().catch(err => {
  console.error('SMOKE TEST CRASH:', err && err.stack || err);
  process.exit(1);
});
