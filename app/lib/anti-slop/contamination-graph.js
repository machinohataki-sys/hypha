'use strict';

// Knowledge Contamination Graph — Anti-Slop v0.5+ P2 init.
// Builds concept-dependency DAG from lesson-N.body.json files; quarantines
// downstream lessons when any source concept appears in
// vault/<slug>/.hypha/quarantined-concepts.jsonl.

const fs = require('node:fs');
const path = require('node:path');
const { buildLedger } = require('./concept-ledger');

function buildGraph({ slug, vaultRoot } = {}) {
  if (typeof slug !== 'string' || !slug.trim() || typeof vaultRoot !== 'string' || !vaultRoot) {
    return { nodes: [], edges: [], quarantined_lessons: [], status: 'INVALID_ARGS' };
  }
  const courseDir = path.join(vaultRoot, slug);
  if (!fs.existsSync(courseDir)) {
    return { nodes: [], edges: [], quarantined_lessons: [], status: 'COURSE_NOT_FOUND' };
  }

  const ledger = buildLedger(courseDir);
  const reuseByTerm = {};
  for (const r of ledger.crossLessonReuse) reuseByTerm[r.term] = r.lessons;
  const nodes = Object.keys(ledger.firstSeen).map(term => ({
    term,
    first_lesson: ledger.firstSeen[term],
    lessons: reuseByTerm[term] || [ledger.firstSeen[term]],
  }));

  const lessonBodies = readLessonBodies(courseDir);
  const edges = [];
  for (const { idx, body } of lessonBodies) {
    const concepts = extractConcepts(body);
    const preReqs = extractPrerequisiteConcepts(body);
    if (preReqs.length === 0) continue;
    for (const c of concepts) {
      for (const pre of preReqs) {
        if (c === pre) continue;
        edges.push({ from: c, to: pre, lesson: idx, type: 'prerequisite' });
      }
    }
  }

  const quarantinedConcepts = readQuarantinedConcepts(courseDir);
  const quarantined_lessons = [];
  if (quarantinedConcepts.size > 0) {
    for (const { idx, body } of lessonBodies) {
      const concepts = extractConcepts(body);
      const hit = concepts.find(c => quarantinedConcepts.has(c));
      if (hit) {
        quarantined_lessons.push({
          lesson_idx: idx,
          source_concept: hit,
          reason: 'concept source flagged',
        });
      }
    }
  }

  return {
    nodes,
    edges,
    quarantined_lessons,
    stats: {
      total_concepts: nodes.length,
      total_edges: edges.length,
      max_depth: computeMaxDepth(nodes, edges),
    },
    status: 'OK',
  };
}

function readLessonBodies(courseDir) {
  if (typeof courseDir !== 'string' || !fs.existsSync(courseDir)) return [];
  const out = [];
  try {
    const entries = fs.readdirSync(courseDir);
    for (const e of entries) {
      const m = /^lesson-(\d+)\.body\.json$/.exec(e);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      if (!Number.isFinite(idx)) continue;
      try {
        const raw = fs.readFileSync(path.join(courseDir, e), 'utf-8');
        const body = JSON.parse(raw);
        out.push({ idx, body });
      } catch (_) { /* malformed body — skip */ }
    }
  } catch (_) { /* dir read fail — return what we have */ }
  return out.sort((a, b) => a.idx - b.idx);
}

function extractConcepts(body) {
  if (!body || typeof body !== 'object') return [];
  const candidates = [];
  if (Array.isArray(body.concepts)) candidates.push(body.concepts);
  if (body.body && Array.isArray(body.body.concepts)) candidates.push(body.body.concepts);
  if (candidates.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const arr of candidates) {
    for (const c of arr) {
      if (typeof c !== 'string') continue;
      const trimmed = c.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function extractPrerequisiteConcepts(body) {
  if (!body || typeof body !== 'object') return [];
  const candidates = [];
  if (Array.isArray(body.prerequisite_concepts)) candidates.push(body.prerequisite_concepts);
  if (body.body && Array.isArray(body.body.prerequisite_concepts)) candidates.push(body.body.prerequisite_concepts);
  if (candidates.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const arr of candidates) {
    for (const c of arr) {
      if (typeof c !== 'string') continue;
      const trimmed = c.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function readQuarantinedConcepts(courseDir) {
  const p = path.join(courseDir, '.hypha', 'quarantined-concepts.jsonl');
  const set = new Set();
  if (!fs.existsSync(p)) return set;
  try {
    const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/).filter(Boolean);
    for (const ln of lines) {
      try {
        const obj = JSON.parse(ln);
        if (obj && typeof obj.concept === 'string' && obj.concept.trim()) {
          set.add(obj.concept.trim());
        }
      } catch (_) { /* skip malformed line */ }
    }
  } catch (_) { /* file read fail — empty set */ }
  return set;
}

function computeMaxDepth(nodes, edges) {
  if (nodes.length === 0 || edges.length === 0) return 0;
  const adj = {};
  for (const e of edges) {
    if (!adj[e.from]) adj[e.from] = new Set();
    adj[e.from].add(e.to);
  }
  // Longest path in DAG via memoized DFS. Cycles guarded by `onStack`.
  const memo = {};
  const onStack = new Set();
  function longestFrom(term) {
    if (term in memo) return memo[term];
    if (onStack.has(term)) return 0; // cycle break — treat back-edge as 0
    onStack.add(term);
    let best = 0;
    const next = adj[term];
    if (next) for (const t of next) {
      const sub = 1 + longestFrom(t);
      if (sub > best) best = sub;
    }
    onStack.delete(term);
    memo[term] = best;
    return best;
  }
  let maxD = 0;
  for (const n of nodes) {
    const d = longestFrom(n.term);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

module.exports = {
  buildGraph,
  extractConcepts,
  extractPrerequisiteConcepts,
  readLessonBodies,
  readQuarantinedConcepts,
};
