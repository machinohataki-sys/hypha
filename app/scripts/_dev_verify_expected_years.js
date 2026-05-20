'use strict';
//
// HYPHA · _dev_verify_expected_years — smoke test for expected-years-estimator
// ============================================================================
//
// Mocks:
//   - hypha-scout.scoutFrontier → returns fixed 5 case-trajectory sources
//     for Nobel literature; empty/canonical-only for SQL.
//   - llm.executeChat (T4_JUDGE) → returns fixed parsed cases JSON.
//
// Verifies:
//   - Nobel case: conservative_years > 20 (real laureates: Mo Yan 31y, Murakami
//     never won so should be filtered/null, Ishiguro 36y, Kawabata 47y, Lessing 56y)
//   - cases.length >= 5
//   - sources_used > 0
//   - estimate:done emits with p50, p75, source_count
//   - SQL case: conservative_years < 2 (low difficulty + tiny p* + low feas)
//
// Usage:
//   node app/scripts/_dev_verify_expected_years.js
//
// Exit 0 on PASS N/N, 1 on any FAIL.

const path = require('path');
const Module = require('module');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) {
  if (!cond) throw new Error('assert failed: ' + (msg || '(no message)'));
}

// ──────────────────────────────────────────────────────────────────────────
// Mock fixtures
// ──────────────────────────────────────────────────────────────────────────

const NOBEL_SOURCES = [
  { title: 'Mo Yan career arc Nobel 2012',     url: 'https://example.com/moyan',     snippet: 'Mo Yan started writing in 1981 and won the Nobel Prize in Literature in 2012.', dimension: 'case-trajectory', layer: 'frontier-scout', query_origin: 'mock' },
  { title: 'Kazuo Ishiguro path to recognition', url: 'https://example.com/ishiguro', snippet: 'Ishiguro published first novel 1982; awarded Nobel 2017.', dimension: 'case-trajectory', layer: 'frontier-scout', query_origin: 'mock' },
  { title: 'Yasunari Kawabata long career',     url: 'https://example.com/kawabata',  snippet: 'Kawabata first publication 1921; Nobel 1968.', dimension: 'case-trajectory', layer: 'frontier-scout', query_origin: 'mock' },
  { title: 'Doris Lessing late laureate',       url: 'https://example.com/lessing',   snippet: 'Lessing published The Grass is Singing 1950; Nobel 2007.', dimension: 'case-trajectory', layer: 'frontier-scout', query_origin: 'mock' },
  { title: 'Olga Tokarczuk recognition timeline', url: 'https://example.com/tokarczuk', snippet: 'Tokarczuk first novel 1993; Nobel 2018.', dimension: 'case-trajectory', layer: 'frontier-scout', query_origin: 'mock' },
];

const NOBEL_LLM_PARSE = {
  cases: [
    { name: '莫言 / Mo Yan',        role: '作家',     start_year: 1981, achieve_year: 2012, hours_estimate_if_known: null, source_url: 'https://example.com/moyan',    notes: 'Nobel laureate 2012' },
    { name: 'Kazuo Ishiguro',       role: 'novelist', start_year: 1982, achieve_year: 2017, hours_estimate_if_known: null, source_url: 'https://example.com/ishiguro', notes: 'Nobel laureate 2017' },
    { name: 'Yasunari Kawabata',    role: 'novelist', start_year: 1921, achieve_year: 1968, hours_estimate_if_known: null, source_url: 'https://example.com/kawabata', notes: 'Nobel laureate 1968' },
    { name: 'Doris Lessing',        role: 'novelist', start_year: 1950, achieve_year: 2007, hours_estimate_if_known: null, source_url: 'https://example.com/lessing',  notes: 'Nobel laureate 2007' },
    { name: 'Olga Tokarczuk',       role: 'novelist', start_year: 1993, achieve_year: 2018, hours_estimate_if_known: null, source_url: 'https://example.com/tokarczuk', notes: 'Nobel laureate 2018' },
  ],
  confidence_per_case: [0.9, 0.95, 0.85, 0.9, 0.9],
};

// SQL — keyword "read" + "understand" → low difficulty, no case-trajectory sources.
const SQL_SOURCES = [];

const SQL_LLM_PARSE = {
  cases: [],
  confidence_per_case: [],
};

// ── HYPHA Gap 2 — hallucination filter fixture ──────────────────────────────
// 3 sources mentioning real names + years; LLM returns 5 cases, 2 of which are
// hallucinated (name/year NOT in any source). Filter must keep 3, drop 2.
const HALLU_SOURCES = [
  { title: 'Mo Yan career arc Nobel 2012',          url: 'https://example.com/moyan',    snippet: 'Mo Yan started writing in 1981 and won the Nobel Prize in Literature in 2012.', dimension: 'case-trajectory', layer: 'frontier-scout', query_origin: 'mock' },
  { title: 'Kazuo Ishiguro path to recognition',     url: 'https://example.com/ishiguro', snippet: 'Ishiguro published first novel 1982; awarded Nobel 2017.',                       dimension: 'case-trajectory', layer: 'frontier-scout', query_origin: 'mock' },
  { title: 'Yasunari Kawabata long career',          url: 'https://example.com/kawabata', snippet: 'Kawabata first publication 1921; Nobel 1968.',                                   dimension: 'case-trajectory', layer: 'frontier-scout', query_origin: 'mock' },
];

const HALLU_LLM_PARSE = {
  cases: [
    // ✓ legit: name + both years appear in HALLU_SOURCES[0]
    { name: 'Mo Yan',              role: '作家',     start_year: 1981, achieve_year: 2012, hours_estimate_if_known: null, source_url: 'https://example.com/moyan',    notes: 'in source' },
    // ✓ legit: name + both years appear in HALLU_SOURCES[1]
    { name: 'Kazuo Ishiguro',      role: 'novelist', start_year: 1982, achieve_year: 2017, hours_estimate_if_known: null, source_url: 'https://example.com/ishiguro', notes: 'in source' },
    // ✓ legit: name + both years appear in HALLU_SOURCES[2]
    { name: 'Yasunari Kawabata',   role: 'novelist', start_year: 1921, achieve_year: 1968, hours_estimate_if_known: null, source_url: 'https://example.com/kawabata', notes: 'in source' },
    // ✗ hallucination 1: name NOT in any source (LLM completed from training)
    { name: 'Gabriel García Márquez', role: 'novelist', start_year: 1955, achieve_year: 1982, hours_estimate_if_known: null, source_url: 'https://example.com/marquez', notes: 'fabricated — no source mentions Marquez' },
    // ✗ hallucination 2: name in source BUT both years are NOT (LLM completed years)
    { name: 'Mo Yan',              role: '作家',     start_year: 1976, achieve_year: 2010, hours_estimate_if_known: null, source_url: 'https://example.com/moyan',    notes: 'years 1976/2010 not in any source' },
  ],
  confidence_per_case: [0.9, 0.95, 0.85, 0.6, 0.5],
};

// ──────────────────────────────────────────────────────────────────────────
// Mock layer
// ──────────────────────────────────────────────────────────────────────────

let _currentNorthStar = '';

function _scenarioFor(ns) {
  // Distinguish 3 mock scenarios by northStar string. `HALLU_PROBE` is a magic
  // marker only the Gap 2 test uses, so production-shaped 'nobel' goals still
  // route to the original NOBEL_* fixtures.
  if (/HALLU_PROBE/.test(ns)) return 'hallu';
  if (/nobel|诺贝尔|literature laureate/i.test(ns)) return 'nobel';
  return 'sql';
}

function _mockScoutFrontier(args) {
  const ns = String(args && args.northStar || '');
  _currentNorthStar = ns;
  const scenario = _scenarioFor(ns);
  const sources = scenario === 'nobel' ? NOBEL_SOURCES
                : scenario === 'hallu' ? HALLU_SOURCES
                : SQL_SOURCES;
  if (typeof args.onProgress === 'function') {
    args.onProgress('scout:start', { northStar: ns, mode: args.mode });
    args.onProgress('scout:done', { totalSources: sources.length, rounds: 1, mode: args.mode });
  }
  return Promise.resolve({
    sources,
    meta: { rounds: 1, dimensions: ['canonical', 'frontier', 'counterargument', 'engineering', 'cross-domain', 'pedagogy', 'case-trajectory'], coverage: { 'case-trajectory': sources.length }, mode: args.mode },
  });
}

function _mockExecuteChat(capability /*, args */) {
  if (capability === 'T4_JUDGE') {
    const scenario = _scenarioFor(_currentNorthStar);
    const parse = scenario === 'nobel' ? NOBEL_LLM_PARSE
                : scenario === 'hallu' ? HALLU_LLM_PARSE
                : SQL_LLM_PARSE;
    return Promise.resolve({
      result: parse,
      providerId: 'mock-glm', model: 'mock-glm-4.5-air', capability, attempts: 1, usage: null,
    });
  }
  if (capability === 'T6_STRONG') {
    // Should not be invoked because we intercept scoutFrontier upstream — but
    // be lenient.
    return Promise.resolve({
      result: { queries: [] },
      providerId: 'mock-glm', model: 'mock-glm-5.1', capability, attempts: 1, usage: null,
    });
  }
  throw new Error('mock executeChat does not handle capability ' + capability);
}

// Hijack require() for two modules used by the estimator:
//   '../harvest/hypha-scout' → override scoutFrontier
//   '../llm'                 → override executeChat
const _origLoad = Module._load;
Module._load = function patched(request, parent /* , ... */) {
  const id = _origLoad.apply(this, arguments);
  try {
    if (parent && parent.filename && /[\\/]creation[\\/]expected-years-estimator\.js$/.test(parent.filename)) {
      if (request === '../harvest/hypha-scout') {
        return { scoutFrontier: _mockScoutFrontier };
      }
      if (request === '../llm') {
        return Object.assign({}, id, { executeChat: _mockExecuteChat });
      }
    }
  } catch (_) {}
  return id;
};

// ──────────────────────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────────────────────

test('estimate — Nobel literature returns conservative_years > 20', async () => {
  // Re-require to pick up patched require()
  delete require.cache[require.resolve('../lib/creation/expected-years-estimator')];
  const { estimate } = require('../lib/creation/expected-years-estimator');

  const stages = [];
  const result = await estimate({
    goalContract: {
      north_star_goal: '成为诺贝尔文学奖得主',
      main_creation: '出版长篇小说',
      learning_model: 'growth',
      current_level: 'beginner',
    },
    archetype: { id: 'humanities', label: 'HUMANITIES' },
    settings: {},
    onProgress: (stage, payload) => stages.push({ stage, payload }),
  });

  assert(result && typeof result === 'object', 'estimate returned non-object');
  assert(typeof result.conservative_years === 'number', 'conservative_years not number');
  assert(result.conservative_years > 20, `conservative_years expected > 20, got ${result.conservative_years}`);
  assert(Array.isArray(result.evidence), 'evidence not array');
  assert(result.evidence.length >= 5, `evidence.length expected >= 5, got ${result.evidence.length}`);
  assert(result.sources_used > 0, `sources_used expected > 0, got ${result.sources_used}`);
  assert(result.p50 != null && result.p50 > 0, `p50 not present: ${result.p50}`);
  assert(result.p75 != null && result.p75 > 0, `p75 not present: ${result.p75}`);

  // Cases have years computed
  const withYears = result.evidence.filter(c => Number.isFinite(c.years));
  assert(withYears.length >= 5, `expected >= 5 cases with computed years, got ${withYears.length}`);

  // estimate:done emitted
  const doneStage = stages.find(s => s.stage === 'estimate:done');
  assert(doneStage, 'estimate:done not emitted');
  assert(typeof doneStage.payload.conservative_years === 'number', 'estimate:done.conservative_years missing');
  assert(typeof doneStage.payload.source_count === 'number', 'estimate:done.source_count missing');

  // estimate:cases-found emitted with samples
  const casesFoundStage = stages.find(s => s.stage === 'estimate:cases-found');
  assert(casesFoundStage, 'estimate:cases-found not emitted');
  assert(casesFoundStage.payload.count >= 5, 'cases-found.count < 5');
  assert(Array.isArray(casesFoundStage.payload.samples) && casesFoundStage.payload.samples.length <= 3, 'cases-found.samples missing/wrong');

  console.log(`    [diag] conservative_years=${result.conservative_years}  p50=${result.p50}  p75=${result.p75}  modal=${result.modal}  sources=${result.sources_used}  feas_p90=${result._meta.feasibility_years_p90}  used_feas_floor=${result.used_feasibility_floor}`);
  console.log(`    [diag] samples: ${casesFoundStage.payload.samples.join(' / ')}`);
});

test('estimate — low-difficulty goal (learn SQL) returns conservative_years < 2', async () => {
  delete require.cache[require.resolve('../lib/creation/expected-years-estimator')];
  const { estimate } = require('../lib/creation/expected-years-estimator');

  const stages = [];
  const result = await estimate({
    goalContract: {
      north_star_goal: '理解 SQL 基础, read 简单查询语句',  // matches "beginner" keywords
      main_creation: 'practice 写 SELECT 查询',              // matches "low" load
      learning_model: 'casual',
      current_level: 'from scratch',
    },
    archetype: { id: 'tech-concept', label: 'TECH-CONCEPT' },
    settings: {},
    onProgress: (stage, payload) => stages.push({ stage, payload }),
  });

  assert(result && typeof result === 'object', 'estimate returned non-object');
  assert(typeof result.conservative_years === 'number', 'conservative_years not number');
  assert(result.conservative_years < 2, `conservative_years expected < 2, got ${result.conservative_years}`);
  assert(result.sources_used === 0, `expected 0 trajectory sources for SQL, got ${result.sources_used}`);
  assert(result.evidence.length === 0, `expected 0 cases for SQL, got ${result.evidence.length}`);
  // With no cases, must rely on feasibility floor
  assert(result.used_feasibility_floor === true, 'expected used_feasibility_floor=true when no trajectory cases');

  console.log(`    [diag] conservative_years=${result.conservative_years}  feas_p90=${result._meta.feasibility_years_p90}  target_diff=${result._meta.target_difficulty}`);
});

test('estimate — Gap 2 hallucination filter drops 2/5 cases (name + year)', async () => {
  delete require.cache[require.resolve('../lib/creation/expected-years-estimator')];
  const { estimate } = require('../lib/creation/expected-years-estimator');

  const stages = [];
  const result = await estimate({
    goalContract: {
      // HALLU_PROBE magic marker → mock scout returns HALLU_SOURCES + LLM
      // returns HALLU_LLM_PARSE (5 cases, 2 hallucinated).
      north_star_goal: 'HALLU_PROBE 成为诺贝尔文学奖得主',
      main_creation: '出版长篇小说',
      learning_model: 'growth',
      current_level: 'beginner',
    },
    archetype: { id: 'humanities', label: 'HUMANITIES' },
    settings: {},
    onProgress: (stage, payload) => stages.push({ stage, payload }),
  });

  // _meta.filter_diagnostic shape
  assert(result._meta && result._meta.filter_diagnostic, '_meta.filter_diagnostic missing');
  const fd = result._meta.filter_diagnostic;
  assert(fd.cases_raw_from_llm === 5, `cases_raw_from_llm expected 5, got ${fd.cases_raw_from_llm}`);
  assert(fd.cases_kept === 3,           `cases_kept expected 3, got ${fd.cases_kept}`);
  assert(fd.cases_filtered_hallucinated === 2, `cases_filtered_hallucinated expected 2, got ${fd.cases_filtered_hallucinated}`);
  assert(Array.isArray(fd.filter_reasons) && fd.filter_reasons.length === 2, `filter_reasons.length expected 2, got ${fd.filter_reasons && fd.filter_reasons.length}`);

  // Reason types — one "name not in any source" (Marquez), one "year not in any source" (Mo Yan 1976/2010)
  const reasonTypes = fd.filter_reasons.map(r => r.reason).sort();
  assert(reasonTypes.includes('name not in any source'), `expected 'name not in any source' reason, got ${reasonTypes.join(' / ')}`);
  assert(reasonTypes.includes('year not in any source'), `expected 'year not in any source' reason, got ${reasonTypes.join(' / ')}`);

  // evidence array should be the FILTERED set (3 cases)
  assert(result.evidence.length === 3, `evidence.length expected 3 (post-filter), got ${result.evidence.length}`);

  // estimate:hallucination-filtered emit
  const filterStage = stages.find(s => s.stage === 'estimate:hallucination-filtered');
  assert(filterStage, 'estimate:hallucination-filtered not emitted');
  assert(filterStage.payload.raw === 5,      `emit.raw expected 5, got ${filterStage.payload.raw}`);
  assert(filterStage.payload.kept === 3,     `emit.kept expected 3, got ${filterStage.payload.kept}`);
  assert(filterStage.payload.filtered === 2, `emit.filtered expected 2, got ${filterStage.payload.filtered}`);
  assert(Array.isArray(filterStage.payload.top_reasons) && filterStage.payload.top_reasons.length === 2, 'top_reasons missing/wrong');

  // confidence_per_case must re-align with kept cases (3, not 5)
  assert(Array.isArray(result._meta.confidence_per_case) && result._meta.confidence_per_case.length === 3, `confidence_per_case re-align expected length 3, got ${result._meta.confidence_per_case && result._meta.confidence_per_case.length}`);

  console.log(`    [diag] raw=${fd.cases_raw_from_llm} kept=${fd.cases_kept} filtered=${fd.cases_filtered_hallucinated}  reasons=${reasonTypes.join(' | ')}`);
});

test('estimate — empty goal degrades gracefully', async () => {
  delete require.cache[require.resolve('../lib/creation/expected-years-estimator')];
  const { estimate } = require('../lib/creation/expected-years-estimator');

  const result = await estimate({
    goalContract: { north_star_goal: '' },
    onProgress: () => {},
  });
  assert(result.conservative_years >= 0.3, 'empty goal must still return floor 0.3');
  assert(result.evidence.length === 0, 'empty goal evidence should be []');
  assert(result.sources_used === 0, 'empty goal sources_used should be 0');
  assert(result._meta && result._meta.degraded_reason, 'expected degraded_reason note on empty goal');
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
      console.log(`    ${f.err && f.err.stack ? f.err.stack.split('\n').slice(0, 6).join('\n    ') : f.err}`);
    }
    process.exit(1);
  }
})();
