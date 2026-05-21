'use strict';

// HYPHA · Concept Ledger
//
// Two surfaces in one module, kept SURGICAL backward compatible:
//
//   v0.4.12 (pre-existing) — pure-JS body reader. Walks
//     vault/<slug>/lesson-N.body.json, extracts `concepts[]`, returns a map
//     of {term → [lesson_idx, ...]}. Consumers:
//       - app/lib/anti-slop/contamination-graph.js (buildLedger + extractConcepts)
//       - app/scripts/_dev_verify_concept_ledger.js (CL1-CL5)
//       - course-trust-panel.jsx 概念一致 editorial row
//     These contracts are FROZEN — do not rename, do not change return shape.
//
//   v0.4.14 boot-8 (this slice) — JSONL persistence layer with drift
//     detection. recordLessonConcepts(...) appends one record per lesson to
//     vault/<slug>/concept-ledger.jsonl with timestamp + definition phrases.
//     buildLedger(...) overload accepts ({slug, vaultRoot}) and returns the
//     richer Map<concept, [{lessonIdx, definition, kind, ts}, ...]> for
//     drift consumers. detectDriftCases(...) finds concepts whose
//     definitions diverge across lessons (Jaccard bigram overlap < 0.4).
//     listConceptUsage(...) returns per-lesson refs. computeConsistencyScore()
//     returns 0..1.
//
// Drift algorithm rationale (per spec — rule-based, no embeddings):
//   - Tokenize each definition into character bigrams (Chinese-tolerant);
//     fall back to lowercased ASCII bigrams for Roman scripts.
//   - Jaccard overlap = |A ∩ B| / |A ∪ B|; threshold 0.4 below which we
//     classify as drift. (Pure terms identical → 1.0; total disjoint → 0.0.)
//   - drift_kind heuristics: rename (longer ↔ shorter ≥ 2x), redefine
//     (definitions disjoint), narrow (subset by token), expand (superset
//     by token). drift_severity = 1 - max-overlap across pairs.
//
// Idempotency: recordLessonConcepts dedups by (slug, lessonIdx) — re-writing
// the same lesson rewrites that row, never doubles.
//
// Embeddings deferred to v0.6+. No LLM calls.

const fs = require('node:fs');
const path = require('node:path');

// ─── v0.4.12 legacy API (frozen — used by contamination-graph + smoke) ────

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
        const parsed = JSON.parse(raw);
        out.push({ idx, body: parsed, fileName: e });
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
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
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

// buildLedger — DUAL signature, dispatched on first arg shape:
//   buildLedger(courseDir: string)
//     → legacy v0.4.12 return (FROZEN contract — CL1-CL5 smoke + contamination-graph)
//   buildLedger({ slug, vaultRoot })
//     → v0.4.14 enriched Map<concept_name, [{lessonIdx, definition, kind, ts}]>
//       merged from JSONL persisted records + live body files.
function buildLedger(arg) {
  if (typeof arg === 'string') return _buildLedgerLegacy(arg);
  if (arg && typeof arg === 'object' && typeof arg.slug === 'string' && typeof arg.vaultRoot === 'string') {
    return _buildLedgerEnriched(arg);
  }
  // unrecognized input → safe empty legacy shape (callers depending on the
  // legacy shape may pass weird things during partial wire-up).
  return {
    totalLessons: 0, totalConceptInstances: 0, totalUniqueConcepts: 0,
    crossLessonReuse: [], firstSeen: {}, lessonsCovered: [],
  };
}

function _buildLedgerLegacy(courseDir) {
  const lessons = readLessonBodies(courseDir);
  const firstSeen = {};
  const occurrences = {};
  let totalConceptInstances = 0;
  for (const { idx, body } of lessons) {
    const concepts = extractConcepts(body);
    totalConceptInstances += concepts.length;
    for (const c of concepts) {
      if (!(c in firstSeen)) firstSeen[c] = idx;
      if (!occurrences[c]) occurrences[c] = [];
      if (!occurrences[c].includes(idx)) occurrences[c].push(idx);
    }
  }
  const totalUniqueConcepts = Object.keys(firstSeen).length;
  const crossLessonReuse = [];
  for (const term of Object.keys(occurrences)) {
    if (occurrences[term].length >= 2) {
      crossLessonReuse.push({ term, lessons: occurrences[term].slice() });
    }
  }
  crossLessonReuse.sort((a, b) => b.lessons.length - a.lessons.length);
  return {
    totalLessons: lessons.length,
    totalConceptInstances,
    totalUniqueConcepts,
    crossLessonReuse,
    firstSeen,
    lessonsCovered: lessons.map(l => l.idx),
  };
}

// ─── v0.4.14 enriched API: JSONL persistence + drift ───────────────────────

function _ledgerPath(vaultRoot, slug) {
  if (typeof slug !== 'string' || !slug.trim()) {
    throw new Error('concept-ledger: slug required (non-empty string)');
  }
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    throw new Error('concept-ledger: slug must not contain path separators');
  }
  if (typeof vaultRoot !== 'string' || !vaultRoot) {
    throw new Error('concept-ledger: vaultRoot required (non-empty string)');
  }
  return path.join(vaultRoot, slug, 'concept-ledger.jsonl');
}

// recordLessonConcepts({slug, vaultRoot, lessonIdx, concepts,
//                       prerequisite_concepts, claims_definitions, ts})
//
//   Appends one record per call (atomic via fs.appendFileSync). Idempotency:
//   we dedup by (lessonIdx). If the JSONL already has a row for this
//   lessonIdx, the new row supersedes it on read (buildLedger picks the
//   LATEST row per lesson). We do NOT rewrite the file — keep append-only.
//
//   claims_definitions: Record<concept_name, string> (definition phrase per
//     concept, typically the first sentence in the lesson body that mentions
//     it). When absent for a concept, drift detection skips that pair.
//
//   Returns { ok: true, path, recorded } on success; { ok: false, error }
//   on schema violation.
function recordLessonConcepts({
  slug, vaultRoot, lessonIdx, concepts, prerequisite_concepts,
  claims_definitions, ts,
} = {}) {
  // Schema gates — fail closed, never throw to caller (caller is a fire-and-
  // forget post-write hook; we don't want a malformed record to break the
  // lesson-body-generate IPC).
  if (typeof slug !== 'string' || !slug.trim()) {
    return { ok: false, error: 'BAD_SLUG' };
  }
  if (typeof vaultRoot !== 'string' || !vaultRoot) {
    return { ok: false, error: 'BAD_VAULT_ROOT' };
  }
  if (!Number.isFinite(lessonIdx) || lessonIdx < 0) {
    return { ok: false, error: 'BAD_LESSON_IDX' };
  }
  const cArr = Array.isArray(concepts) ? concepts.filter(s => typeof s === 'string' && s.trim()) : [];
  const pArr = Array.isArray(prerequisite_concepts)
    ? prerequisite_concepts.filter(s => typeof s === 'string' && s.trim())
    : [];
  const defs = (claims_definitions && typeof claims_definitions === 'object' && !Array.isArray(claims_definitions))
    ? claims_definitions : {};
  // Validate definition values are strings (silently drop non-string).
  const cleanDefs = {};
  for (const k of Object.keys(defs)) {
    if (typeof defs[k] === 'string' && defs[k].trim()) cleanDefs[k] = defs[k].trim();
  }
  const stamp = ts || new Date().toISOString();
  const record = {
    slug,
    lessonIdx: Number(lessonIdx),
    concepts: cArr.map(s => s.trim()),
    prerequisite_concepts: pArr.map(s => s.trim()),
    claims_definitions: cleanDefs,
    ts: stamp,
  };
  let absPath;
  try { absPath = _ledgerPath(vaultRoot, slug); }
  catch (err) { return { ok: false, error: 'BAD_PATH', message: err.message }; }
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.appendFileSync(absPath, JSON.stringify(record) + '\n', 'utf-8');
    return { ok: true, path: absPath, recorded: record };
  } catch (err) {
    return { ok: false, error: 'WRITE_FAILED', message: err && err.message };
  }
}

function _readLedgerJSONL(vaultRoot, slug) {
  let absPath;
  try { absPath = _ledgerPath(vaultRoot, slug); }
  catch (_) { return []; }
  if (!fs.existsSync(absPath)) return [];
  try {
    const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const ln of lines) {
      try {
        const obj = JSON.parse(ln);
        if (obj && typeof obj === 'object' && Number.isFinite(obj.lessonIdx)) {
          out.push(obj);
        }
      } catch (_) { /* skip malformed line */ }
    }
    return out;
  } catch (_) { return []; }
}

// Idempotency policy: when multiple records share the same lessonIdx, the
// LATEST (last appended) wins. This matches "re-recording same lesson
// doesn't double-count" per spec.
function _latestPerLesson(records) {
  const byIdx = new Map();
  for (const r of records) {
    if (!byIdx.has(r.lessonIdx)) byIdx.set(r.lessonIdx, r);
    else {
      const prev = byIdx.get(r.lessonIdx);
      const prevTs = prev.ts || '';
      const curTs = r.ts || '';
      if (curTs >= prevTs) byIdx.set(r.lessonIdx, r);
    }
  }
  return Array.from(byIdx.values()).sort((a, b) => a.lessonIdx - b.lessonIdx);
}

// _buildLedgerEnriched({slug, vaultRoot})
//   → returns the Map<concept, [{lessonIdx, definition, kind, ts}, ...]>
//     shape requested by spec. `kind` ∈ {'new', 'reused', 'prerequisite'}:
//     - 'new'      = first lesson that introduces this concept (concepts[])
//     - 'reused'   = subsequent lesson that lists same concept (concepts[])
//     - 'prerequisite' = concept appears only in prerequisite_concepts[]
function _buildLedgerEnriched({ slug, vaultRoot }) {
  const records = _latestPerLesson(_readLedgerJSONL(vaultRoot, slug));
  const map = {};
  const seenAsNew = new Set();
  for (const rec of records) {
    const defs = rec.claims_definitions || {};
    const lessonConcepts = new Set(rec.concepts || []);
    for (const c of (rec.concepts || [])) {
      const def = defs[c] || '';
      const kind = seenAsNew.has(c) ? 'reused' : 'new';
      seenAsNew.add(c);
      if (!map[c]) map[c] = [];
      map[c].push({ lessonIdx: rec.lessonIdx, definition: def, kind, ts: rec.ts });
    }
    // A prerequisite entry records that THIS lesson depends on the term.
    // It is independent of whether earlier lessons already minted the term
    // as `new`/`reused`. The only suppression is when the same lesson also
    // lists the term in its own concepts[] (already booked above).
    for (const p of (rec.prerequisite_concepts || [])) {
      if (lessonConcepts.has(p)) continue;
      if (!map[p]) map[p] = [];
      const already = map[p].some(e => e.lessonIdx === rec.lessonIdx);
      if (!already) {
        map[p].push({ lessonIdx: rec.lessonIdx, definition: '', kind: 'prerequisite', ts: rec.ts });
      }
    }
  }
  return map;
}

// ─── tokenization + Jaccard (rule-based, embeddings deferred to v0.6+) ────

function _tokenize(s) {
  if (typeof s !== 'string') return new Set();
  const cleaned = s.trim();
  if (!cleaned) return new Set();
  // Strip common punctuation that adds noise to bigram overlap.
  const normalized = cleaned.replace(/[　-〿＀-￯.,;:!?()\[\]{}<>'"`~/\\\-_*+=|]/g, ' ')
    .replace(/\s+/g, ' ').toLowerCase();
  const tokens = new Set();
  // Character bigrams — Chinese-tolerant and Roman-tolerant.
  for (let i = 0; i < normalized.length - 1; i++) {
    const bg = normalized.slice(i, i + 2);
    if (bg.trim().length === 2) tokens.add(bg);
  }
  // Also include whitespace-split unigram words ≥3 chars for English.
  for (const w of normalized.split(' ')) {
    if (w.length >= 3) tokens.add(w);
  }
  return tokens;
}

function _jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 1 : intersect / union;
}

function _classifyDrift(defA, defB, overlapAB) {
  // overlapAB low → diverge. Use length ratios + token containment to
  // classify the kind. Order-stable: A always = earlier lesson.
  const lenA = (defA || '').length;
  const lenB = (defB || '').length;
  const tA = _tokenize(defA);
  const tB = _tokenize(defB);
  // containment: |A ∩ B| / |A| and / |B|
  let inter = 0;
  for (const t of tA) if (tB.has(t)) inter++;
  const contA = tA.size === 0 ? 0 : inter / tA.size;
  const contB = tB.size === 0 ? 0 : inter / tB.size;
  if (overlapAB >= 0.4) return null; // not drift
  // rename: one definition is much shorter (≤ 50%) than other AND high one-way
  // containment → looks like the same idea renamed/abbreviated.
  if ((lenA > 0 && lenB > 0) && (lenA <= lenB * 0.5 || lenB <= lenA * 0.5) && Math.max(contA, contB) >= 0.6) {
    return 'rename';
  }
  // narrow: B is a subset of A (contB high, contA low)
  if (contB >= 0.7 && contA < 0.4) return 'narrow';
  // expand: A is a subset of B (contA high, contB low)
  if (contA >= 0.7 && contB < 0.4) return 'expand';
  // otherwise the definitions are largely disjoint.
  return 'redefine';
}

// detectDriftCases({slug, vaultRoot}) — returns [{concept, lessons:[...],
//   drift_severity:0..1, drift_kind}] for concepts whose definitions diverge
//   across ≥2 lessons. Concepts seen in only one lesson, or with no
//   definitions captured, are not drift candidates.
function detectDriftCases({ slug, vaultRoot } = {}) {
  let records;
  try { records = _latestPerLesson(_readLedgerJSONL(vaultRoot, slug)); }
  catch (_) { return []; }
  const conceptDefs = {}; // concept → [{idx, def}, ...]
  for (const rec of records) {
    const defs = rec.claims_definitions || {};
    for (const c of (rec.concepts || [])) {
      const def = defs[c];
      if (typeof def !== 'string' || !def.trim()) continue;
      if (!conceptDefs[c]) conceptDefs[c] = [];
      conceptDefs[c].push({ idx: rec.lessonIdx, def: def.trim() });
    }
  }
  const out = [];
  for (const concept of Object.keys(conceptDefs)) {
    const entries = conceptDefs[concept];
    if (entries.length < 2) continue;
    // Score every pair; min overlap = max drift.
    let minOverlap = 1;
    let worstA = entries[0], worstB = entries[1];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const ovl = _jaccard(_tokenize(entries[i].def), _tokenize(entries[j].def));
        if (ovl < minOverlap) {
          minOverlap = ovl;
          worstA = entries[i];
          worstB = entries[j];
        }
      }
    }
    if (minOverlap >= 0.4) continue; // consistent enough
    const driftKind = _classifyDrift(worstA.def, worstB.def, minOverlap) || 'redefine';
    out.push({
      concept,
      lessons: entries.map(e => ({ idx: e.idx, definition: e.def })),
      drift_severity: Math.max(0, Math.min(1, 1 - minOverlap)),
      drift_kind: driftKind,
    });
  }
  // Most-severe first.
  out.sort((a, b) => b.drift_severity - a.drift_severity);
  return out;
}

// listConceptUsage({slug, vaultRoot, concept}) — returns the per-lesson refs
//   for one concept, classified as new/reused/prerequisite. Concept absent
//   from ledger → empty array.
function listConceptUsage({ slug, vaultRoot, concept } = {}) {
  if (typeof concept !== 'string' || !concept.trim()) return [];
  const map = _buildLedgerEnriched({ slug, vaultRoot });
  const term = concept.trim();
  return Array.isArray(map[term]) ? map[term].slice() : [];
}

// computeConsistencyScore({slug, vaultRoot}) — fraction of multi-lesson
//   concepts that are consistent (no drift detected). Returns 1 when nothing
//   is reused across lessons (vacuously consistent).
function computeConsistencyScore({ slug, vaultRoot } = {}) {
  let records;
  try { records = _latestPerLesson(_readLedgerJSONL(vaultRoot, slug)); }
  catch (_) { return 1; }
  const conceptDefs = {};
  for (const rec of records) {
    const defs = rec.claims_definitions || {};
    for (const c of (rec.concepts || [])) {
      const def = defs[c];
      if (typeof def !== 'string' || !def.trim()) continue;
      if (!conceptDefs[c]) conceptDefs[c] = [];
      conceptDefs[c].push(def.trim());
    }
  }
  const multi = Object.keys(conceptDefs).filter(c => conceptDefs[c].length >= 2);
  if (multi.length === 0) return 1;
  const drifts = detectDriftCases({ slug, vaultRoot });
  const driftSet = new Set(drifts.map(d => d.concept));
  let consistent = 0;
  for (const c of multi) if (!driftSet.has(c)) consistent++;
  return consistent / multi.length;
}

// extractDefinitionPhrasesFromBody(body, concepts) — helper for post-write
//   hook. Returns Record<concept, definition_phrase> where definition_phrase
//   is the first sentence in `thesis + canonical_example + mechanism_explanation`
//   that mentions the concept. No NLP — pure substring scan + sentence split.
function extractDefinitionPhrasesFromBody(body, concepts) {
  const out = {};
  if (!body || typeof body !== 'object' || !Array.isArray(concepts)) return out;
  const corpusParts = [];
  for (const f of ['thesis', 'canonical_example', 'mechanism_explanation', 'intro_prose']) {
    if (typeof body[f] === 'string' && body[f].trim()) corpusParts.push(body[f].trim());
  }
  const corpus = corpusParts.join('\n\n');
  if (!corpus) return out;
  // Sentence split on Chinese full stop / period / newline.
  const sentences = corpus.split(/[。.\n]+/).map(s => s.trim()).filter(s => s.length >= 6);
  for (const c of concepts) {
    if (typeof c !== 'string' || !c.trim()) continue;
    const term = c.trim();
    const hit = sentences.find(s => s.includes(term));
    if (hit) out[term] = hit.slice(0, 300);
  }
  return out;
}

module.exports = {
  // legacy v0.4.12 (FROZEN — contamination-graph + smoke + Trust Panel)
  readLessonBodies,
  extractConcepts,
  extractPrerequisiteConcepts,
  buildLedger,
  // v0.4.14 enriched API
  recordLessonConcepts,
  detectDriftCases,
  listConceptUsage,
  computeConsistencyScore,
  extractDefinitionPhrasesFromBody,
  // exposed for smoke
  _readLedgerJSONL,
  _latestPerLesson,
  _tokenize,
  _jaccard,
  _ledgerPath,
};
