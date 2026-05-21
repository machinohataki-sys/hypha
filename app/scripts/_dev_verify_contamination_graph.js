#!/usr/bin/env node
'use strict';

// HYPHA v0.5.0-bootstrap — Anti-Slop P2 Knowledge Contamination Graph smoke.
//
// Validates app/lib/anti-slop/contamination-graph.js:
//   CG1: buildGraph on nonexistent course returns COURSE_NOT_FOUND
//   CG2: buildGraph on empty course (no body files) returns empty nodes/edges
//   CG3: buildGraph with 2 synthetic body files extracts concepts as nodes
//   CG4: buildGraph creates prerequisite edges from body.prerequisite_concepts
//   CG5: quarantined_lessons populated when concept appears in
//        .hypha/quarantined-concepts.jsonl
//
// Run: node app/scripts/_dev_verify_contamination_graph.js
// Exit 0 = PASS, exit 1 = any failure.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildGraph,
  extractConcepts,
  extractPrerequisiteConcepts,
} = require('../lib/anti-slop/contamination-graph');

const tests = [];
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  PASS  ${name}`); }
  else { failed++; tests.push(`  FAIL  ${name}${extra ? '\n        ' + extra : ''}`); }
}

function mkScratch(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hypha-contamination-${label}-`));
}
function rmScratch(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// ─── CG1: nonexistent course ─────────────────────────────────────────────
{
  const vaultRoot = mkScratch('cg1');
  try {
    const g = buildGraph({ slug: 'no-such-slug', vaultRoot });
    check('CG1a status === COURSE_NOT_FOUND', g.status === 'COURSE_NOT_FOUND', `got ${g.status}`);
    check('CG1b nodes === []', Array.isArray(g.nodes) && g.nodes.length === 0);
    check('CG1c edges === []', Array.isArray(g.edges) && g.edges.length === 0);
    check('CG1d quarantined_lessons === []', Array.isArray(g.quarantined_lessons) && g.quarantined_lessons.length === 0);

    const bad = buildGraph({ slug: '', vaultRoot });
    check('CG1e empty slug → INVALID_ARGS', bad.status === 'INVALID_ARGS');
    const bad2 = buildGraph({ slug: 'x', vaultRoot: '' });
    check('CG1f empty vaultRoot → INVALID_ARGS', bad2.status === 'INVALID_ARGS');
    const bad3 = buildGraph();
    check('CG1g no args → INVALID_ARGS', bad3.status === 'INVALID_ARGS');
  } finally { rmScratch(vaultRoot); }
}

// ─── CG2: empty course (dir exists, no body files) ───────────────────────
{
  const vaultRoot = mkScratch('cg2');
  const slug = 'empty-course';
  fs.mkdirSync(path.join(vaultRoot, slug));
  try {
    const g = buildGraph({ slug, vaultRoot });
    check('CG2a status === OK', g.status === 'OK', `got ${g.status}`);
    check('CG2b nodes === []', g.nodes.length === 0);
    check('CG2c edges === []', g.edges.length === 0);
    check('CG2d quarantined_lessons === []', g.quarantined_lessons.length === 0);
    check('CG2e stats.total_concepts === 0', g.stats.total_concepts === 0);
    check('CG2f stats.total_edges === 0', g.stats.total_edges === 0);
    check('CG2g stats.max_depth === 0', g.stats.max_depth === 0);
  } finally { rmScratch(vaultRoot); }
}

// ─── CG3: 2 synthetic body files → concepts as nodes ─────────────────────
{
  const vaultRoot = mkScratch('cg3');
  const slug = 'syn-concepts';
  const dir = path.join(vaultRoot, slug);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'lesson-0.body.json'), JSON.stringify({ concepts: ['Algebra', 'Linearity'] }));
  fs.writeFileSync(path.join(dir, 'lesson-1.body.json'), JSON.stringify({ body: { concepts: ['Linearity', 'Tensor'] } }));
  try {
    const g = buildGraph({ slug, vaultRoot });
    check('CG3a status === OK', g.status === 'OK');
    check('CG3b 3 unique nodes', g.nodes.length === 3, `nodes=${JSON.stringify(g.nodes.map(n => n.term))}`);
    const terms = g.nodes.map(n => n.term).sort();
    check('CG3c node terms = [Algebra, Linearity, Tensor]', JSON.stringify(terms) === JSON.stringify(['Algebra', 'Linearity', 'Tensor']));
    const lin = g.nodes.find(n => n.term === 'Linearity');
    check('CG3d Linearity first_lesson === 0', lin && lin.first_lesson === 0);
    check('CG3e Linearity lessons spans [0,1]', lin && JSON.stringify(lin.lessons) === '[0,1]');
    check('CG3f no edges absent prerequisite_concepts', g.edges.length === 0);
    check('CG3g stats.total_concepts === 3', g.stats.total_concepts === 3);
  } finally { rmScratch(vaultRoot); }
}

// ─── CG4: prerequisite edges from prerequisite_concepts ──────────────────
{
  const vaultRoot = mkScratch('cg4');
  const slug = 'preq';
  const dir = path.join(vaultRoot, slug);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'lesson-0.body.json'), JSON.stringify({
    concepts: ['Foundations'],
    prerequisite_concepts: [],
  }));
  fs.writeFileSync(path.join(dir, 'lesson-1.body.json'), JSON.stringify({
    concepts: ['Calculus'],
    prerequisite_concepts: ['Foundations'],
  }));
  fs.writeFileSync(path.join(dir, 'lesson-2.body.json'), JSON.stringify({
    body: {
      concepts: ['DiffEq'],
      prerequisite_concepts: ['Calculus', 'Foundations'],
    },
  }));
  try {
    const g = buildGraph({ slug, vaultRoot });
    check('CG4a status === OK', g.status === 'OK');
    check('CG4b 3 nodes', g.nodes.length === 3);
    check('CG4c 3 edges total', g.edges.length === 3, `edges=${JSON.stringify(g.edges)}`);
    const calcEdge = g.edges.find(e => e.from === 'Calculus' && e.to === 'Foundations');
    check('CG4d edge Calculus → Foundations on lesson 1', calcEdge && calcEdge.lesson === 1 && calcEdge.type === 'prerequisite');
    const diffToCalc = g.edges.find(e => e.from === 'DiffEq' && e.to === 'Calculus');
    check('CG4e edge DiffEq → Calculus on lesson 2 (nested body shape)', diffToCalc && diffToCalc.lesson === 2);
    const diffToFnd = g.edges.find(e => e.from === 'DiffEq' && e.to === 'Foundations');
    check('CG4f edge DiffEq → Foundations on lesson 2', !!diffToFnd);
    check('CG4g no self-loop in edges', g.edges.every(e => e.from !== e.to));
    check('CG4h extractPrerequisiteConcepts reads top-level', JSON.stringify(extractPrerequisiteConcepts({ prerequisite_concepts: ['X', 'Y'] })) === '["X","Y"]');
    check('CG4i extractPrerequisiteConcepts reads nested body', JSON.stringify(extractPrerequisiteConcepts({ body: { prerequisite_concepts: ['Z'] } })) === '["Z"]');
    check('CG4j extractPrerequisiteConcepts dedupes whitespace', JSON.stringify(extractPrerequisiteConcepts({ prerequisite_concepts: ['A', ' A ', '', null] })) === '["A"]');
    check('CG4k extractConcepts and extractPrerequisiteConcepts both export', typeof extractConcepts === 'function' && typeof extractPrerequisiteConcepts === 'function');
    check('CG4l max_depth >= 1 (DiffEq → Calculus → Foundations)', g.stats.max_depth >= 2, `got ${g.stats.max_depth}`);
  } finally { rmScratch(vaultRoot); }
}

// ─── CG5: quarantined_lessons populated when concept flagged ─────────────
{
  const vaultRoot = mkScratch('cg5');
  const slug = 'quar';
  const dir = path.join(vaultRoot, slug);
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, '.hypha'));
  fs.writeFileSync(path.join(dir, 'lesson-0.body.json'), JSON.stringify({ concepts: ['Phlogiston'] }));
  fs.writeFileSync(path.join(dir, 'lesson-1.body.json'), JSON.stringify({ concepts: ['Phlogiston', 'Combustion'] }));
  fs.writeFileSync(path.join(dir, 'lesson-2.body.json'), JSON.stringify({ concepts: ['Oxygen'] }));
  // 2 quarantine rows + 1 malformed line that should be ignored silently.
  const jsonl = [
    JSON.stringify({ concept: 'Phlogiston', reason: 'theory retracted', ts: '2026-05-19' }),
    '{ malformed not-json',
    JSON.stringify({ concept: '  ', reason: 'whitespace only' }),
    JSON.stringify({ note: 'no concept field here' }),
  ].join('\n');
  fs.writeFileSync(path.join(dir, '.hypha', 'quarantined-concepts.jsonl'), jsonl);
  try {
    const g = buildGraph({ slug, vaultRoot });
    check('CG5a status === OK', g.status === 'OK');
    check('CG5b 2 lessons quarantined (0 and 1)', g.quarantined_lessons.length === 2, `got ${JSON.stringify(g.quarantined_lessons)}`);
    const idxs = g.quarantined_lessons.map(q => q.lesson_idx).sort();
    check('CG5c quarantined idxs === [0,1]', JSON.stringify(idxs) === '[0,1]');
    const q0 = g.quarantined_lessons.find(q => q.lesson_idx === 0);
    check('CG5d lesson-0 source_concept === Phlogiston', q0 && q0.source_concept === 'Phlogiston');
    check('CG5e lesson-0 reason populated', q0 && typeof q0.reason === 'string' && q0.reason.length > 0);
    const q2 = g.quarantined_lessons.find(q => q.lesson_idx === 2);
    check('CG5f lesson-2 (Oxygen only) NOT quarantined', !q2);
  } finally { rmScratch(vaultRoot); }
}

// ─── report ──────────────────────────────────────────────────────────────
console.log(tests.join('\n'));
console.log(`\n[verify] ${passed} pass, ${failed} fail (total ${passed + failed})`);
process.exit(failed === 0 ? 0 : 1);
