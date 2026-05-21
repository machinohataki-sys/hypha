'use strict';

// HYPHA · _dev_verify_prereq_concepts_emit
//
// Closes GP3 (golden-path E2E boot-5): contamination-graph expects
// body.prerequisite_concepts as string[]; pre-2026-05-20 generateLessonBodyV2
// did NOT emit this field. Result: real LLM bodies → graph degenerates to
// zero edges (nodes-only). This smoke locks the wiring:
//
//   P1: validateBodyV2 accepts emitted prerequisite_concepts as string[]
//   P2: validateBodyV2 tolerates MISSING prerequisite_concepts (legacy bodies)
//   P3: validateBodyV2 REJECTS malformed prerequisite_concepts (string, num, obj)
//   P4: contamination-graph extractor reads the new shape
//   P5: synthetic body w/ concepts + prereqs → graph builds nodes AND edges
//   P6: BODY_V2_SYSTEM_PROMPT includes "prerequisite_concepts" instruction
//   P7: regression — existing 11-field validation still rejects malformed bodies
//   P8: end-to-end — validate(synthetic) PASS → buildGraph(seeded vault) edges>0
//
// Pure-Node, no LLM dispatch. Self-contained vault under tmp dir; cleaned on
// exit. Read-only against lesson-body-generator + contamination-graph.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  validateBodyV2,
  _BODY_V2_SYSTEM_PROMPT,
} = require('../lib/lesson-body-generator');
const {
  buildGraph,
  extractPrerequisiteConcepts,
  extractConcepts,
} = require('../lib/anti-slop/contamination-graph');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push({ label, detail });
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Minimal-but-valid 11-field body. We mutate this per-test to exercise the
// prereq_concepts schema delta without re-deriving the full schema each time.
function baseValidBody(overrides = {}) {
  return {
    thesis: '认知图谱以节点与边为最小单位, 节点承载实体, 边承载关系。',
    canonical_example: '张三的"努力工作"标为节点 A, "升职"标为节点 B, 连一条有向因果边, 这就是图谱的最小单位。后续推理沿这条边回溯。',
    common_misconceptions: [
      '认为节点必须是名词 —— 实际事件、状态也可成节点',
      '认为图谱越大越好 —— 实际可读的小图比庞杂大图更可用',
    ],
    exit_proof: '能在白板上画三个相互关联的概念节点并解释每条边的方向与理由, 错一条即重画。',
    mechanism_explanation: '概念图谱把隐性关联外化为节点与边的拓扑, 推理就是沿边的传播, 错误就是边方向或节点身份的错位, 修正落在某一条边而非整张图。',
    jargon_list: ['节点 — 承载实体或事件的最小单位', '边 — 节点之间的关系或因果'],
    note_connection: '基于上一节"知识表征的层级"往前推进, 把抽象层级落到具体拓扑。',
    ...overrides,
  };
}

console.log('\n--- P1 validateBodyV2 with valid prerequisite_concepts ---');
{
  const b = baseValidBody({
    concepts: ['认知图谱', '节点', '边'],
    prerequisite_concepts: ['知识表征', '层级'],
  });
  const errs = validateBodyV2(b);
  check('P1a no validation errors when prereq_concepts is string[]', errs.length === 0, errs.join('; '));
  check('P1b body retains emitted prerequisite_concepts array', Array.isArray(b.prerequisite_concepts) && b.prerequisite_concepts.length === 2);
}

console.log('\n--- P2 validateBodyV2 tolerates MISSING prerequisite_concepts ---');
{
  const b = baseValidBody(); // no prereq_concepts, no concepts
  const errs = validateBodyV2(b);
  check('P2a missing prereq_concepts must NOT fail validation (legacy bodies)',
        errs.length === 0,
        errs.join('; '));
  // Same for missing concepts.
  check('P2b missing concepts must NOT fail validation (legacy bodies)',
        !errs.some(e => /^concepts:/.test(e)),
        errs.filter(e => /^concepts:/.test(e)).join('; '));
}

console.log('\n--- P3 validateBodyV2 REJECTS malformed prerequisite_concepts ---');
{
  const b1 = baseValidBody({ prerequisite_concepts: 'not-an-array' });
  const e1 = validateBodyV2(b1);
  check('P3a string-instead-of-array → fail with "must be array"',
        e1.some(e => /^prerequisite_concepts: must be array/.test(e)),
        e1.join('; '));

  const b2 = baseValidBody({ prerequisite_concepts: [1, 2, 3] });
  const e2 = validateBodyV2(b2);
  check('P3b array-of-numbers → fail per-index with "must be string"',
        e2.some(e => /^prerequisite_concepts\[0\]: must be string/.test(e)),
        e2.join('; '));

  const b3 = baseValidBody({
    prerequisite_concepts: ['valid', 'x'.repeat(80)], // 80-char term > 60 cap
  });
  const e3 = validateBodyV2(b3);
  check('P3c entry over 60 chars → fail "too long"',
        e3.some(e => /^prerequisite_concepts\[1\]: too long/.test(e)),
        e3.join('; '));

  const b4 = baseValidBody({
    prerequisite_concepts: new Array(13).fill('a'),
  });
  const e4 = validateBodyV2(b4);
  check('P3d 13 entries (> 12 cap) → fail "too many entries"',
        e4.some(e => /^prerequisite_concepts: too many entries/.test(e)),
        e4.join('; '));
}

console.log('\n--- P4 contamination-graph extractor reads the shape ---');
{
  const r1 = extractPrerequisiteConcepts({ prerequisite_concepts: ['A', 'B', 'C'] });
  check('P4a extractor reads top-level prereq_concepts → 3 entries',
        Array.isArray(r1) && r1.length === 3 && r1.includes('A'));
  const r2 = extractPrerequisiteConcepts({ body: { prerequisite_concepts: ['X'] } });
  check('P4b extractor reads nested body.prereq_concepts → 1 entry',
        Array.isArray(r2) && r2.length === 1 && r2[0] === 'X');
  const r3 = extractPrerequisiteConcepts({});
  check('P4c missing field → returns []', Array.isArray(r3) && r3.length === 0);
}

console.log('\n--- P5 synthetic vault → buildGraph yields nodes + edges ---');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-prereq-smoke-'));
const SLUG = 'smoke-prereq-graph';
{
  const courseDir = path.join(tmpRoot, SLUG);
  fs.mkdirSync(courseDir, { recursive: true });

  // Lesson 0 introduces 3 root concepts, no upstream prereqs.
  // Lesson 1 introduces 3 more concepts; its prereqs land in lesson 0.
  // Lesson 2 introduces 2 more; its prereqs land in lesson 1.
  // Expected: 8 unique nodes (3+3+2), edges = lesson1.concepts × lesson1.prereqs
  //   + lesson2.concepts × lesson2.prereqs (filtered: from !== to).
  const lessons = [
    {
      idx: 0,
      body: {
        thesis: 'tx0', canonical_example: 'cx0', exit_proof: 'ex0',
        mechanism_explanation: 'mx0', note_connection: 'nc0',
        common_misconceptions: ['m0a', 'm0b'], jargon_list: [],
        concepts: ['图谱', '节点', '边'],
        prerequisite_concepts: [],
      },
    },
    {
      idx: 1,
      body: {
        thesis: 'tx1', canonical_example: 'cx1', exit_proof: 'ex1',
        mechanism_explanation: 'mx1', note_connection: 'nc1',
        common_misconceptions: ['m1a', 'm1b'], jargon_list: [],
        concepts: ['有向边', '无向边', '双向边'],
        prerequisite_concepts: ['节点', '边'],
      },
    },
    {
      idx: 2,
      body: {
        thesis: 'tx2', canonical_example: 'cx2', exit_proof: 'ex2',
        mechanism_explanation: 'mx2', note_connection: 'nc2',
        common_misconceptions: ['m2a', 'm2b'], jargon_list: [],
        concepts: ['推理路径', '中断点'],
        prerequisite_concepts: ['有向边', '双向边'],
      },
    },
  ];
  for (const { idx, body } of lessons) {
    fs.writeFileSync(path.join(courseDir, `lesson-${idx}.body.json`),
      JSON.stringify(body, null, 2));
  }

  const g = buildGraph({ slug: SLUG, vaultRoot: tmpRoot });
  check('P5a buildGraph status OK', g && g.status === 'OK', JSON.stringify(g));
  check('P5b nodes count > 0 (graph reads body.concepts)',
        Array.isArray(g.nodes) && g.nodes.length > 0,
        `nodes=${g.nodes && g.nodes.length}`);
  // Expected nodes = 3+3+2 = 8 unique concept terms.
  check('P5c nodes count === 8 (3 lessons × distinct concept sets)',
        g.nodes.length === 8,
        `got ${g.nodes.length}: ${JSON.stringify(g.nodes.map(n => n.term))}`);
  check('P5d edges count > 0 (real edges, NOT zero — GP5 closure)',
        Array.isArray(g.edges) && g.edges.length > 0,
        `edges=${g.edges && g.edges.length}`);
  // Expected edges:
  //   lesson 1: 3 concepts × 2 prereqs = 6
  //   lesson 2: 2 concepts × 2 prereqs = 4 (filtered: from !== to drops nothing here)
  //   total = 10
  check('P5e edges count === 10 (lesson1: 3×2 + lesson2: 2×2)',
        g.edges.length === 10,
        `got ${g.edges.length}`);
  check('P5f every edge has type=prerequisite',
        g.edges.every(e => e.type === 'prerequisite'));
}

console.log('\n--- P6 BODY_V2_SYSTEM_PROMPT mentions prerequisite_concepts ---');
{
  check('P6a prompt mentions "prerequisite_concepts"',
        typeof _BODY_V2_SYSTEM_PROMPT === 'string' &&
        _BODY_V2_SYSTEM_PROMPT.includes('prerequisite_concepts'));
  check('P6b prompt also mentions "concepts" (paired emission for graph nodes)',
        /\n\s+concepts\s+—/.test(_BODY_V2_SYSTEM_PROMPT));
  check('P6c prompt clarifies prereq != current-lesson concepts',
        /DEPENDS on|depends on|MUST already know/i.test(_BODY_V2_SYSTEM_PROMPT));
}

console.log('\n--- P7 regression: existing 11-field validation still works ---');
{
  // Missing thesis → existing required-field error MUST still fire.
  const b = baseValidBody(); delete b.thesis;
  const errs = validateBodyV2(b);
  check('P7a missing thesis still rejected', errs.some(e => /^thesis:/.test(e)));
  // common_misconceptions array length still checked.
  const b2 = baseValidBody({ common_misconceptions: ['only one'] });
  const e2 = validateBodyV2(b2);
  check('P7b common_misconceptions length still enforced',
        e2.some(e => /expected exactly 2 entries/.test(e)));
  // Empty body fully rejected.
  check('P7c empty body returns errors',
        validateBodyV2({}).length > 0);
}

console.log('\n--- P8 end-to-end: validate → graph build → real edges ---');
{
  const SLUG2 = 'smoke-prereq-e2e';
  const courseDir = path.join(tmpRoot, SLUG2);
  fs.mkdirSync(courseDir, { recursive: true });

  const b = baseValidBody({
    concepts: ['A', 'B', 'C'],
    prerequisite_concepts: ['P1', 'P2'],
  });
  const errs = validateBodyV2(b);
  check('P8a synthetic body passes validation', errs.length === 0, errs.join('; '));

  // Also seed a downstream lesson so we get real edges.
  fs.writeFileSync(path.join(courseDir, 'lesson-0.body.json'),
    JSON.stringify({ ...baseValidBody(), concepts: ['P1', 'P2'], prerequisite_concepts: [] }, null, 2));
  fs.writeFileSync(path.join(courseDir, 'lesson-1.body.json'),
    JSON.stringify(b, null, 2));

  const g = buildGraph({ slug: SLUG2, vaultRoot: tmpRoot });
  check('P8b end-to-end graph builds OK', g.status === 'OK');
  check('P8c end-to-end edges > 0', g.edges.length > 0, `edges=${g.edges.length}`);
}

// Cleanup tmp vault.
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* best-effort */ }

console.log(`\n=== _dev_verify_prereq_concepts_emit summary ===`);
console.log(`pass: ${pass}`);
console.log(`fail: ${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? ` :: ${f.detail}` : ''}`);
  process.exit(1);
}
process.exit(0);
