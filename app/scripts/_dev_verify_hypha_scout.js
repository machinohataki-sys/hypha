'use strict';
//
// HYPHA · _dev_verify_hypha_scout — smoke test for hypha-scout.js
// ===============================================================
//
// Mocks: executeChat (returns canned 6-dim query plan + coverage assessment)
//        + global fetch (returns 3 source per Tavily call).
//
// Verifies:
//   - sources.length > 0
//   - meta.rounds >= 1
//   - meta.coverage has all 6 dimension keys
//   - byDimension never includes an unknown dimension
//   - onProgress fires expected stages in order
//   - tavily-skipped emits when no API key + no fetch global pretend
//
// Usage:
//   node app/scripts/_dev_verify_hypha_scout.js
//
// Exit code 0 on PASS N/N; 1 on any FAIL.

const path = require('path');
const Module = require('module');

// ──────────────────────────────────────────────────────────────────────────
// Test framework (tiny)
// ──────────────────────────────────────────────────────────────────────────

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function assert(cond, msg) {
  if (!cond) throw new Error('assert failed: ' + (msg || '(no message)'));
}

// ──────────────────────────────────────────────────────────────────────────
// Mock executeChat via require-cache hijack
// ──────────────────────────────────────────────────────────────────────────

const MOCK_QUERY_PLAN = {
  queries: [
    { query: 'foundations of AI agent architecture textbook',          dimension: 'canonical',       why: '经典教材' },
    { query: 'agent harness arxiv 2025',                                dimension: 'frontier',        why: '前沿论文' },
    { query: 'multi-agent orchestration critique failure',              dimension: 'counterargument', why: '反方/失败' },
    { query: 'langchain langgraph github example',                      dimension: 'engineering',     why: '开源实现' },
    { query: 'biology immune system analogy for distributed systems',   dimension: 'cross-domain',    why: '类比' },
    { query: 'Karpathy explain LLM agents blog',                        dimension: 'pedagogy',        why: '入门讲解' },
    { query: 'industrial control loop classical reference',             dimension: 'canonical',       why: '经典补' },
    { query: 'arxiv 2026 emergent agent capability',                    dimension: 'frontier',        why: '前沿补' },
  ],
};

const MOCK_ASSESSMENT = {
  coverage: { canonical: 2, frontier: 2, counterargument: 1, engineering: 1, 'cross-domain': 1, pedagogy: 1 },
  gaps: ['counterargument 不足', 'engineering 不足', 'cross-domain 不足', 'pedagogy 不足'],
  extra_queries: [
    { query: 'why AI agents fail in production retrospective', dimension: 'counterargument', why: '失败案例补' },
    { query: 'open source agent framework github 2025',         dimension: 'engineering',     why: '开源补' },
    { query: 'evolutionary biology analogy multi-agent',        dimension: 'cross-domain',    why: '生物学类比' },
    { query: 'beginner-friendly AI agent video tutorial',       dimension: 'pedagogy',        why: '入门视频' },
  ],
};

// Track LLM-router invocations so we can sanity-check the test, not the prod code.
const _llmCalls = [];

function _mockExecuteChat(capability /*, args */) {
  _llmCalls.push(capability);
  if (capability === 'T6_STRONG') {
    return Promise.resolve({
      result: MOCK_QUERY_PLAN,
      providerId: 'mock-glm', model: 'mock-glm-5.1', capability, attempts: 1, usage: null,
    });
  }
  if (capability === 'T4_JUDGE') {
    return Promise.resolve({
      result: MOCK_ASSESSMENT,
      providerId: 'mock-glm', model: 'mock-glm-4.5-air', capability, attempts: 1, usage: null,
    });
  }
  throw new Error('mock executeChat does not handle capability ' + capability);
}

// Replace ../llm.executeChat by intercepting require() of '../llm' from inside the harvest dir.
const _origResolve = Module._resolveFilename;
const _origLoad    = Module._load;
const LLM_PATH = path.resolve(__dirname, '..', 'lib', 'llm', 'index.js');

Module._load = function patched(request, parent /* , ... */) {
  const id = _origLoad.apply(this, arguments);
  // After load, if it's the llm/index module, override executeChat.
  try {
    if (parent && parent.filename && /[\\/]harvest[\\/]hypha-scout-llm\.js$/.test(parent.filename) && request === '../llm') {
      return Object.assign({}, id, { executeChat: _mockExecuteChat });
    }
  } catch (_) {}
  return id;
};

// ──────────────────────────────────────────────────────────────────────────
// Mock global.fetch — Tavily returns 3 sources per query
// ──────────────────────────────────────────────────────────────────────────

let _fetchCallCount = 0;
function _installMockFetch(mode /* 'tavily' | 'fallback' */) {
  _fetchCallCount = 0;
  global.fetch = async function mockFetch(url, opts) {
    _fetchCallCount += 1;
    if (mode === 'tavily' && /api\.tavily\.com\/search/.test(url)) {
      const body = JSON.parse(opts.body);
      return {
        ok: true,
        async json() {
          return {
            results: [
              { url: `https://example.com/${encodeURIComponent(body.query)}/a`, title: `A for ${body.query}`,  content: 'snippet A about ' + body.query },
              { url: `https://example.com/${encodeURIComponent(body.query)}/b`, title: `B for ${body.query}`,  content: 'snippet B about ' + body.query },
              { url: `https://example.com/${encodeURIComponent(body.query)}/c`, title: `C for ${body.query}`,  content: 'snippet C about ' + body.query },
            ],
          };
        },
      };
    }
    if (mode === 'fallback') {
      // Mock Wikipedia + arxiv responses for fallback path
      if (/wikipedia\.org\/w\/api\.php/.test(url)) {
        return {
          ok: true,
          async json() {
            return [
              'q',
              ['Wiki title 1', 'Wiki title 2'],
              ['Wiki desc 1', 'Wiki desc 2'],
              ['https://en.wikipedia.org/wiki/Wiki1', 'https://en.wikipedia.org/wiki/Wiki2'],
            ];
          },
        };
      }
      if (/export\.arxiv\.org\/api\/query/.test(url)) {
        return {
          ok: true,
          async text() {
            return [
              '<?xml version="1.0"?><feed>',
              '<entry><title>Arxiv paper A</title><id>https://arxiv.org/abs/2601.00001</id><summary>summary A</summary></entry>',
              '<entry><title>Arxiv paper B</title><id>https://arxiv.org/abs/2601.00002</id><summary>summary B</summary></entry>',
              '</feed>',
            ].join('');
          },
        };
      }
    }
    return { ok: false, status: 404, async json() { return {}; }, async text() { return ''; } };
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────────────────────

test('scoutFrontier — happy path with Tavily mock', async () => {
  _installMockFetch('tavily');
  process.env.HYPHA_LLM_NO_RECOVERY = '1';
  // Avoid TAVILY_API_KEY-not-set fallback by injecting via settings.
  const { scoutFrontier } = require('../lib/harvest/hypha-scout');

  const stages = [];
  const result = await scoutFrontier({
    northStar:    '成为 AI Agent Builder',
    mainCreation: '生产环境多 agent 协作系统',
    archetype:    { id: 'tech-concept', label: 'TECH-CONCEPT' },
    settings:     { tavilyKey: 'sk-fake-tavily-key' },
    onProgress:   (stage, payload) => stages.push({ stage, payload }),
  });

  assert(result && typeof result === 'object', 'scoutFrontier returned non-object');
  assert(Array.isArray(result.sources), 'result.sources not array');
  assert(result.sources.length > 0, 'result.sources empty');
  assert(result.meta && typeof result.meta === 'object', 'result.meta missing');
  assert(typeof result.meta.rounds === 'number' && result.meta.rounds >= 1, 'rounds < 1');
  assert(Array.isArray(result.meta.dimensions), 'meta.dimensions not array');

  const cov = result.meta.coverage;
  assert(cov && typeof cov === 'object', 'meta.coverage missing');
  const EXPECTED_DIMS = ['canonical', 'frontier', 'counterargument', 'engineering', 'cross-domain', 'pedagogy'];
  for (const d of EXPECTED_DIMS) {
    assert(Object.prototype.hasOwnProperty.call(cov, d), `coverage missing dim ${d}`);
    assert(typeof cov[d] === 'number', `coverage[${d}] not number`);
  }

  // Every source must have a known dimension
  for (const s of result.sources) {
    assert(EXPECTED_DIMS.includes(s.dimension), `source has unknown dim ${s.dimension}`);
    assert(s.layer === 'frontier-scout', `source.layer != frontier-scout: ${s.layer}`);
    assert(typeof s.url === 'string' && s.url, 'source.url empty');
    assert(typeof s.query_origin === 'string', 'source.query_origin missing');
  }

  // Expected stages — at minimum: start, queries-generated, search-round-done, done.
  const stageNames = stages.map(s => s.stage);
  assert(stageNames.includes('scout:start'),                'missing scout:start');
  assert(stageNames.includes('scout:queries-generated'),    'missing scout:queries-generated');
  assert(stageNames.includes('scout:search-round-done'),    'missing scout:search-round-done');
  assert(stageNames.includes('scout:coverage-assessed'),    'missing scout:coverage-assessed');
  assert(stageNames.includes('scout:done'),                 'missing scout:done');
  assert(!stageNames.includes('scout:tavily-skipped'),      'tavily-skipped fired despite key present');

  // LLM was called: T6_STRONG once for plan, T4_JUDGE at least once for assess.
  assert(_llmCalls.includes('T6_STRONG'), 'T6_STRONG not invoked');
  assert(_llmCalls.includes('T4_JUDGE'),  'T4_JUDGE not invoked');

  // Fetch should have been called for each query (8 round-1 + up to 4 round-2 + maybe more).
  assert(_fetchCallCount >= 8, `expected >= 8 fetch calls, got ${_fetchCallCount}`);
});

test('scoutFrontier — fallback path when TAVILY_API_KEY absent', async () => {
  _installMockFetch('fallback');
  delete process.env.TAVILY_API_KEY;
  // Reset module cache so re-import gets a fresh closure (in case any state leaked).
  delete require.cache[require.resolve('../lib/harvest/hypha-scout')];
  const { scoutFrontier } = require('../lib/harvest/hypha-scout');

  const stages = [];
  const result = await scoutFrontier({
    northStar: 'become a kayaker',
    archetype: 'PHYSICAL-SKILL',
    settings:  {}, // no tavilyKey
    onProgress: (stage, payload) => stages.push({ stage, payload }),
  });

  assert(result.sources.length >= 0, 'fallback path returned undefined sources');
  // Tavily-skipped should fire at least once during round 1.
  const skipStages = stages.filter(s => s.stage === 'scout:tavily-skipped');
  assert(skipStages.length >= 1, 'expected scout:tavily-skipped to fire on no-key path');
});

// ──────────────────────────────────────────────────────────────────────────
// Runner
// ──────────────────────────────────────────────────────────────────────────

(async () => {
  let pass = 0, fail = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass += 1;
      process.stdout.write(`  ok   ${t.name}\n`);
    } catch (e) {
      fail += 1;
      failures.push({ name: t.name, err: e });
      process.stdout.write(`  FAIL ${t.name} — ${e && e.message ? e.message : e}\n`);
    }
  }
  const total = pass + fail;
  if (fail === 0) {
    console.log(`\nPASS ${pass}/${total}`);
    process.exit(0);
  } else {
    console.log(`\nFAIL ${fail}/${total}`);
    for (const f of failures) {
      console.log(`  · ${f.name}`);
      console.log(`    ${f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 4).join('\n    ') : f.err}`);
    }
    process.exit(1);
  }
})();
