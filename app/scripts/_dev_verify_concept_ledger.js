#!/usr/bin/env node
'use strict';

// HYPHA — Concept Ledger smoke (v0.4.12 + v0.4.14 boot-8).
//
// v0.4.12 legacy (FROZEN, CL1-CL5):
//   CL1: extractConcepts returns [] for malformed body (null / {} / wrong type)
//   CL2: extractConcepts filters non-string / empty / whitespace entries
//   CL3: buildLedger on empty dir returns zeroed ledger
//   CL4: buildLedger over 2 synthetic body files yields correct cross-reuse
//   CL5: buildLedger skips non-matching filenames + malformed JSON gracefully
//
// v0.4.14 boot-8 enriched JSONL + drift (CL6-CL15):
//   CL6:  recordLessonConcepts appends valid JSONL row
//   CL7:  recordLessonConcepts rejects malformed input
//   CL8:  buildLedger({slug,vaultRoot}) reads back enriched Map shape
//   CL9:  detectDriftCases finds clear drift across 2 lessons
//   CL10: detectDriftCases returns empty for consistent definitions
//   CL11: listConceptUsage returns correct lesson refs + kind classification
//   CL12: computeConsistencyScore monotonic with drift count
//   CL13: idempotency — re-recording same lesson supersedes (latest wins)
//   CL14: malformed JSONL row tolerated (skip + continue)
//   CL15: legacy buildLedger(courseDir) regression — contamination-graph still
//         reads concepts[] correctly via the FROZEN reader path
//
// Run: node app/scripts/_dev_verify_concept_ledger.js
// Exit 0 = PASS, exit 1 = any failure.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cl = require('../lib/anti-slop/concept-ledger');
const {
  readLessonBodies,
  extractConcepts,
  buildLedger,
  recordLessonConcepts,
  detectDriftCases,
  listConceptUsage,
  computeConsistencyScore,
  extractDefinitionPhrasesFromBody,
  _readLedgerJSONL,
  _latestPerLesson,
  _tokenize,
  _jaccard,
} = cl;

// Also exercise the contamination-graph regression boundary.
const contamination = require('../lib/anti-slop/contamination-graph');

const tests = [];
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  PASS  ${name}`); }
  else { failed++; tests.push(`  FAIL  ${name}${extra ? '\n        ' + extra : ''}`); }
}

function mkScratch(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hypha-concept-ledger-${label}-`));
}
function rmScratch(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// ─── CL1: extractConcepts on malformed body (FROZEN) ─────────────────────
{
  check('CL1a null body → []', Array.isArray(extractConcepts(null)) && extractConcepts(null).length === 0);
  check('CL1b undefined body → []', extractConcepts(undefined).length === 0);
  check('CL1c {} body → []', extractConcepts({}).length === 0);
  check('CL1d concepts:string (not array) → []', extractConcepts({ concepts: 'not-array' }).length === 0);
  check('CL1e concepts:number → []', extractConcepts({ concepts: 42 }).length === 0);
  check('CL1f concepts:null → []', extractConcepts({ concepts: null }).length === 0);
}

// ─── CL2: extractConcepts filters non-string / empty / whitespace (FROZEN) ─
{
  const r = extractConcepts({ concepts: ['A', '', '  ', 'B', null, 42, '  C  ', 'A'] });
  check('CL2a yields exactly 3 valid concepts', r.length === 3, `got ${JSON.stringify(r)}`);
  check('CL2b contains A', r.includes('A'));
  check('CL2c contains B', r.includes('B'));
  check('CL2d contains trimmed C', r.includes('C'));
  check('CL2e dedupes repeat A', r.filter(x => x === 'A').length === 1);
  const nested = extractConcepts({ body: { concepts: ['X', ' Y '] } });
  check('CL2f reads body.concepts nested shape', nested.length === 2 && nested.includes('X') && nested.includes('Y'));
}

// ─── CL3: empty dir + nonexistent dir (FROZEN) ────────────────────────────
{
  const dir = mkScratch('cl3');
  try {
    const ledger = buildLedger(dir);
    check('CL3a empty dir totalLessons === 0', ledger.totalLessons === 0);
    check('CL3b empty dir totalConceptInstances === 0', ledger.totalConceptInstances === 0);
    check('CL3c empty dir totalUniqueConcepts === 0', ledger.totalUniqueConcepts === 0);
    check('CL3d empty dir crossLessonReuse === []', Array.isArray(ledger.crossLessonReuse) && ledger.crossLessonReuse.length === 0);
    check('CL3e empty dir lessonsCovered === []', Array.isArray(ledger.lessonsCovered) && ledger.lessonsCovered.length === 0);
  } finally { rmScratch(dir); }
  const nonexistent = path.join(os.tmpdir(), `hypha-concept-ledger-nope-${Date.now()}-${Math.random()}`);
  const ledger2 = buildLedger(nonexistent);
  check('CL3f nonexistent dir totalLessons === 0', ledger2.totalLessons === 0);
  check('CL3g readLessonBodies(non-string) returns []', readLessonBodies(null).length === 0);
}

// ─── CL4: 2 synthetic lessons w/ cross-reuse (FROZEN) ─────────────────────
{
  const dir = mkScratch('cl4');
  try {
    fs.writeFileSync(path.join(dir, 'lesson-0.body.json'), JSON.stringify({ concepts: ['A', 'B', 'C'] }));
    fs.writeFileSync(path.join(dir, 'lesson-1.body.json'), JSON.stringify({ concepts: ['B', 'D'] }));
    const ledger = buildLedger(dir);
    check('CL4a totalLessons === 2', ledger.totalLessons === 2, `got ${ledger.totalLessons}`);
    check('CL4b totalConceptInstances === 5', ledger.totalConceptInstances === 5, `got ${ledger.totalConceptInstances}`);
    check('CL4c totalUniqueConcepts === 4', ledger.totalUniqueConcepts === 4, `got ${ledger.totalUniqueConcepts}`);
    check('CL4d firstSeen.A === 0', ledger.firstSeen.A === 0);
    check('CL4e firstSeen.B === 0', ledger.firstSeen.B === 0);
    check('CL4f firstSeen.D === 1', ledger.firstSeen.D === 1);
    const reuseB = ledger.crossLessonReuse.find(e => e.term === 'B');
    check('CL4g crossLessonReuse contains B', !!reuseB, `crossLessonReuse=${JSON.stringify(ledger.crossLessonReuse)}`);
    check('CL4h B.lessons === [0,1]', reuseB && JSON.stringify(reuseB.lessons) === '[0,1]');
    check('CL4i crossLessonReuse length === 1', ledger.crossLessonReuse.length === 1);
    check('CL4j lessonsCovered === [0,1]', JSON.stringify(ledger.lessonsCovered) === '[0,1]');
  } finally { rmScratch(dir); }
}

// ─── CL5: ignores non-matching files + skips malformed JSON (FROZEN) ──────
{
  const dir = mkScratch('cl5');
  try {
    fs.writeFileSync(path.join(dir, 'lesson-0.body.json'), JSON.stringify({ concepts: ['A'] }));
    fs.writeFileSync(path.join(dir, 'lesson-2.body.json'), '{ not valid json');
    fs.writeFileSync(path.join(dir, 'lesson.body.json'), JSON.stringify({ concepts: ['ZZZ'] }));
    fs.writeFileSync(path.join(dir, 'lesson-X.body.json'), JSON.stringify({ concepts: ['YYY'] }));
    fs.writeFileSync(path.join(dir, 'lesson-1.txt'), 'plain text not json');
    fs.writeFileSync(path.join(dir, 'README.md'), '# notes');
    fs.mkdirSync(path.join(dir, 'sessions'));
    const ledger = buildLedger(dir);
    check('CL5a only lesson-0 counts (malformed lesson-2 skipped silently)',
      ledger.totalLessons === 1, `totalLessons=${ledger.totalLessons} lessonsCovered=${JSON.stringify(ledger.lessonsCovered)}`);
    check('CL5b lessonsCovered === [0]', JSON.stringify(ledger.lessonsCovered) === '[0]');
    check('CL5c totalUniqueConcepts === 1', ledger.totalUniqueConcepts === 1);
    check('CL5d firstSeen has only A', Object.keys(ledger.firstSeen).length === 1 && ledger.firstSeen.A === 0);
    check('CL5e no ZZZ leakage from lesson.body.json', !('ZZZ' in ledger.firstSeen));
    check('CL5f no YYY leakage from lesson-X.body.json', !('YYY' in ledger.firstSeen));
  } finally { rmScratch(dir); }
}

// ─── v0.4.14 boot-8 enriched JSONL + drift ────────────────────────────────

// CL6: recordLessonConcepts appends valid JSONL row.
{
  const vaultRoot = mkScratch('cl6');
  const slug = 'crse-cl6';
  try {
    const r = recordLessonConcepts({
      slug, vaultRoot, lessonIdx: 0,
      concepts: ['图谱', '节点'],
      prerequisite_concepts: ['知识表征'],
      claims_definitions: { '图谱': '图谱以节点和边表示概念关系', '节点': '节点承载实体' },
    });
    check('CL6a recordLessonConcepts ok=true', r && r.ok === true, JSON.stringify(r));
    check('CL6b row written to vault/<slug>/concept-ledger.jsonl',
      fs.existsSync(path.join(vaultRoot, slug, 'concept-ledger.jsonl')));
    const records = _readLedgerJSONL(vaultRoot, slug);
    check('CL6c JSONL has exactly 1 row', records.length === 1);
    check('CL6d row.slug + lessonIdx round-trip',
      records[0].slug === slug && records[0].lessonIdx === 0);
    check('CL6e claims_definitions persisted',
      records[0].claims_definitions && records[0].claims_definitions['图谱'].includes('节点和边'));
    check('CL6f prerequisite_concepts persisted',
      Array.isArray(records[0].prerequisite_concepts) && records[0].prerequisite_concepts.includes('知识表征'));
    check('CL6g ts is ISO string', typeof records[0].ts === 'string' && /\d{4}-\d{2}-\d{2}T/.test(records[0].ts));
  } finally { rmScratch(vaultRoot); }
}

// CL7: recordLessonConcepts rejects malformed input.
{
  const vaultRoot = mkScratch('cl7');
  try {
    const r1 = recordLessonConcepts({ vaultRoot, lessonIdx: 0, concepts: [] });
    check('CL7a missing slug rejected', r1 && r1.ok === false && r1.error === 'BAD_SLUG');
    const r2 = recordLessonConcepts({ slug: 'crse', lessonIdx: 0, concepts: [] });
    check('CL7b missing vaultRoot rejected', r2 && r2.ok === false && r2.error === 'BAD_VAULT_ROOT');
    const r3 = recordLessonConcepts({ slug: 'crse', vaultRoot, lessonIdx: -1 });
    check('CL7c negative lessonIdx rejected', r3 && r3.ok === false && r3.error === 'BAD_LESSON_IDX');
    const r4 = recordLessonConcepts({ slug: '../bad', vaultRoot, lessonIdx: 0 });
    check('CL7d path-traversal slug rejected', r4 && r4.ok === false && r4.error === 'BAD_PATH');
    const r5 = recordLessonConcepts({ slug: 'crse', vaultRoot, lessonIdx: 0, concepts: [42, null, 'ok'], prerequisite_concepts: 'not-array' });
    check('CL7e malformed concepts gracefully cleaned (still ok)',
      r5 && r5.ok === true && Array.isArray(r5.recorded.concepts) && r5.recorded.concepts.length === 1);
    check('CL7f malformed prerequisite_concepts becomes []',
      r5 && r5.recorded.prerequisite_concepts.length === 0);
  } finally { rmScratch(vaultRoot); }
}

// CL8: buildLedger({slug,vaultRoot}) reads back enriched Map shape.
{
  const vaultRoot = mkScratch('cl8');
  const slug = 'crse-cl8';
  try {
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 0, concepts: ['A', 'B'],
      claims_definitions: { 'A': 'A 是首课定义.', 'B': 'B 是另一首课定义.' } });
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 1, concepts: ['B', 'C'],
      claims_definitions: { 'B': 'B 是另一首课定义.', 'C': 'C 是新增定义.' } });
    const map = buildLedger({ slug, vaultRoot });
    check('CL8a enriched buildLedger returns Map-shaped object', map && typeof map === 'object' && !Array.isArray(map));
    check('CL8b concept A has 1 entry (only lesson 0)', Array.isArray(map.A) && map.A.length === 1);
    check('CL8c concept B has 2 entries (lessons 0 + 1)', Array.isArray(map.B) && map.B.length === 2);
    check('CL8d B.kind: first=new, second=reused',
      map.B[0].kind === 'new' && map.B[1].kind === 'reused');
    check('CL8e B definitions persisted on both entries',
      map.B[0].definition && map.B[1].definition);
    check('CL8f concept C has 1 entry (lesson 1)', Array.isArray(map.C) && map.C.length === 1);
  } finally { rmScratch(vaultRoot); }
}

// CL9: detectDriftCases finds clear drift across 2 lessons.
{
  const vaultRoot = mkScratch('cl9');
  const slug = 'crse-cl9';
  try {
    // "状态机" defined two completely different ways across lessons.
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 0, concepts: ['状态机', '转移'],
      claims_definitions: {
        '状态机': '状态机是用节点表示状态、用边表示转移条件的有向图模型',
        '转移': '转移是从一个状态到另一个状态的边',
      } });
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 1, concepts: ['状态机', '收益'],
      claims_definitions: {
        '状态机': '状态机指的是投资市场常见的牛市熊市循环现象',
        '收益': '收益是投资活动的回报率',
      } });
    const drifts = detectDriftCases({ slug, vaultRoot });
    check('CL9a detectDriftCases returns non-empty', Array.isArray(drifts) && drifts.length >= 1, `got ${JSON.stringify(drifts)}`);
    const sm = drifts.find(d => d.concept === '状态机');
    check('CL9b 状态机 flagged as drift', !!sm);
    check('CL9c drift_severity > 0.5', sm && sm.drift_severity > 0.5);
    check('CL9d lessons array has 2 entries', sm && Array.isArray(sm.lessons) && sm.lessons.length === 2);
    check('CL9e drift_kind is one of redefine/rename/narrow/expand',
      sm && ['redefine', 'rename', 'narrow', 'expand'].includes(sm.drift_kind));
  } finally { rmScratch(vaultRoot); }
}

// CL10: detectDriftCases returns empty for consistent definitions.
{
  const vaultRoot = mkScratch('cl10');
  const slug = 'crse-cl10';
  try {
    // Identical definition wording → 0 drift.
    const sameDef = '图谱以节点表示实体、用边表示关系的拓扑结构';
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 0, concepts: ['图谱'],
      claims_definitions: { '图谱': sameDef } });
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 1, concepts: ['图谱'],
      claims_definitions: { '图谱': sameDef } });
    const drifts = detectDriftCases({ slug, vaultRoot });
    check('CL10a no drift for identical definitions', drifts.length === 0, `got ${JSON.stringify(drifts)}`);
  } finally { rmScratch(vaultRoot); }
}

// CL11: listConceptUsage returns correct lesson refs + kind classification.
{
  const vaultRoot = mkScratch('cl11');
  const slug = 'crse-cl11';
  try {
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 0, concepts: ['张量'],
      claims_definitions: { '张量': '张量是多维数组的数学结构' } });
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 2, concepts: ['张量'],
      claims_definitions: { '张量': '张量是多维数组的数学结构' } });
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 3, concepts: ['梯度'],
      prerequisite_concepts: ['张量'],
      claims_definitions: { '梯度': '梯度是张量对参数的偏导数' } });
    const usage = listConceptUsage({ slug, vaultRoot, concept: '张量' });
    check('CL11a 张量 has 3 usage entries (lesson 0 new + lesson 2 reused + lesson 3 prerequisite)',
      Array.isArray(usage) && usage.length === 3, `usage=${JSON.stringify(usage)}`);
    check('CL11b lesson 0 → kind=new', usage.find(u => u.lessonIdx === 0) && usage.find(u => u.lessonIdx === 0).kind === 'new');
    check('CL11c lesson 2 → kind=reused', usage.find(u => u.lessonIdx === 2) && usage.find(u => u.lessonIdx === 2).kind === 'reused');
    check('CL11d lesson 3 → kind=prerequisite', usage.find(u => u.lessonIdx === 3) && usage.find(u => u.lessonIdx === 3).kind === 'prerequisite');
    const missing = listConceptUsage({ slug, vaultRoot, concept: 'NONEXISTENT' });
    check('CL11e missing concept returns []', Array.isArray(missing) && missing.length === 0);
  } finally { rmScratch(vaultRoot); }
}

// CL12: computeConsistencyScore monotonic with drift count.
{
  const vaultRoot = mkScratch('cl12');
  const slug = 'crse-cl12';
  try {
    // 3 multi-lesson concepts: 0 drift initially.
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 0, concepts: ['A', 'B', 'C'],
      claims_definitions: { 'A': 'A 是 alpha 概念示例', 'B': 'B 是 beta 概念示例', 'C': 'C 是 gamma 概念示例' } });
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 1, concepts: ['A', 'B', 'C'],
      claims_definitions: { 'A': 'A 是 alpha 概念示例', 'B': 'B 是 beta 概念示例', 'C': 'C 是 gamma 概念示例' } });
    const score0 = computeConsistencyScore({ slug, vaultRoot });
    check('CL12a consistency=1.0 when no drift', score0 === 1, `got ${score0}`);
    // Introduce A-drift only.
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 1, concepts: ['A', 'B', 'C'],
      claims_definitions: { 'A': '这条记录把 A 改成完全无关的金融术语 sortino ratio', 'B': 'B 是 beta 概念示例', 'C': 'C 是 gamma 概念示例' } });
    const score1 = computeConsistencyScore({ slug, vaultRoot });
    check('CL12b consistency drops to 2/3 ≈ 0.667 with 1 drift', Math.abs(score1 - 2 / 3) < 0.01, `got ${score1}`);
    check('CL12c score1 < score0', score1 < score0);
    check('CL12d score in [0,1]', score1 >= 0 && score1 <= 1);
  } finally { rmScratch(vaultRoot); }
}

// CL13: idempotency — re-recording same lesson supersedes (latest wins).
{
  const vaultRoot = mkScratch('cl13');
  const slug = 'crse-cl13';
  try {
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 0, concepts: ['X'],
      claims_definitions: { 'X': 'first version definition' }, ts: '2026-05-19T10:00:00.000Z' });
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 0, concepts: ['X'],
      claims_definitions: { 'X': 'second version definition supersedes' }, ts: '2026-05-19T11:00:00.000Z' });
    const records = _readLedgerJSONL(vaultRoot, slug);
    check('CL13a JSONL has 2 raw rows (append-only)', records.length === 2);
    const latest = _latestPerLesson(records);
    check('CL13b _latestPerLesson collapses to 1', latest.length === 1);
    check('CL13c latest is the second-written row',
      latest[0].claims_definitions.X && latest[0].claims_definitions.X.includes('second version'));
    const map = buildLedger({ slug, vaultRoot });
    check('CL13d enriched buildLedger sees only the latest', map.X && map.X.length === 1 && map.X[0].definition.includes('second version'));
  } finally { rmScratch(vaultRoot); }
}

// CL14: malformed JSONL row tolerated (skip + continue).
{
  const vaultRoot = mkScratch('cl14');
  const slug = 'crse-cl14';
  try {
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 0, concepts: ['valid'],
      claims_definitions: { 'valid': 'definition for valid concept' } });
    // Manually corrupt: append a malformed line + a line missing required fields.
    const jp = path.join(vaultRoot, slug, 'concept-ledger.jsonl');
    fs.appendFileSync(jp, '{ this is not valid json\n', 'utf-8');
    fs.appendFileSync(jp, JSON.stringify({ slug, no_lesson_idx: true }) + '\n', 'utf-8');
    recordLessonConcepts({ slug, vaultRoot, lessonIdx: 1, concepts: ['also-valid'],
      claims_definitions: { 'also-valid': 'definition for also valid concept' } });
    const records = _readLedgerJSONL(vaultRoot, slug);
    check('CL14a malformed rows skipped, valid kept (count=2)', records.length === 2);
    const drifts = detectDriftCases({ slug, vaultRoot });
    check('CL14b detectDriftCases survives corrupt rows', Array.isArray(drifts));
    const score = computeConsistencyScore({ slug, vaultRoot });
    check('CL14c computeConsistencyScore survives corrupt rows', typeof score === 'number' && score >= 0 && score <= 1);
  } finally { rmScratch(vaultRoot); }
}

// CL15: legacy buildLedger(courseDir) regression — contamination-graph still
// reads concepts[] correctly via the FROZEN reader path.
{
  const dir = mkScratch('cl15');
  try {
    fs.writeFileSync(path.join(dir, 'lesson-0.body.json'), JSON.stringify({
      concepts: ['图谱', '节点', '边'], prerequisite_concepts: [],
    }));
    fs.writeFileSync(path.join(dir, 'lesson-1.body.json'), JSON.stringify({
      concepts: ['有向边'], prerequisite_concepts: ['节点', '边'],
    }));
    // Legacy reader still must produce the v0.4.12 shape contamination-graph
    // consumes.
    const legacy = buildLedger(dir);
    check('CL15a legacy buildLedger(string) preserves totalLessons',
      legacy.totalLessons === 2);
    check('CL15b legacy firstSeen present for all concepts',
      legacy.firstSeen['图谱'] === 0 && legacy.firstSeen['有向边'] === 1);
    // contamination-graph uses extractConcepts + extractPrerequisiteConcepts +
    // a courseDir-based body reader. It picks up our buildLedger(courseDir)
    // output for the nodes pass.
    const vaultRoot = path.dirname(dir);
    const slug = path.basename(dir);
    const graph = contamination.buildGraph({ slug, vaultRoot });
    check('CL15c contamination.buildGraph status OK', graph && graph.status === 'OK');
    check('CL15d contamination nodes count > 0', Array.isArray(graph.nodes) && graph.nodes.length > 0);
    check('CL15e contamination edges count > 0 (prereq edges)', Array.isArray(graph.edges) && graph.edges.length > 0);
  } finally { rmScratch(dir); }
}

// ─── helpers + tokenization sanity ────────────────────────────────────────
{
  const sim = _jaccard(_tokenize('图谱是节点和边的拓扑'), _tokenize('图谱是节点和边的拓扑结构'));
  check('CL+tokA jaccard self-similar ≥ 0.5', sim >= 0.5, `got ${sim}`);
  const dif = _jaccard(_tokenize('图谱是节点拓扑'), _tokenize('天气预报今天有雨'));
  check('CL+tokB jaccard disjoint < 0.3', dif < 0.3, `got ${dif}`);
  const dphr = extractDefinitionPhrasesFromBody(
    { thesis: '图谱用节点和边表示关系. 节点是实体单位.', mechanism_explanation: '推理沿边传播.' },
    ['图谱', '节点', '不存在']
  );
  check('CL+tokC extractDefinitionPhrasesFromBody finds 图谱', !!dphr['图谱'] && dphr['图谱'].includes('节点'));
  check('CL+tokD extractDefinitionPhrasesFromBody finds 节点', !!dphr['节点']);
  check('CL+tokE extractDefinitionPhrasesFromBody skips missing term', !('不存在' in dphr));
}

// ─── report ──────────────────────────────────────────────────────────────
console.log(tests.join('\n'));
console.log(`\n[verify] ${passed} pass, ${failed} fail (total ${passed + failed})`);
process.exit(failed === 0 ? 0 : 1);
