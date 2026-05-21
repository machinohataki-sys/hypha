#!/usr/bin/env node
'use strict';

// HYPHA · Dependency Graph + Retraction Propagation + Wikilink Resolver smoke.
//
// Per Scout S81 (MSR-MEL multi-source evidence + dependency-graph verifier,
// arXiv 2604.20283 — 89.7% on LongMemEval-KU): extends B1 prediction-field
// schema with `depends_on` edges, cycle-detected DAG persistence, retraction
// cascade emission, and 4-evidence wikilink ranking with lifecycle filter.
//
// Tests (22 — exceeds 18+ floor):
//   DG1  addEdge happy path persists to vault/.hypha/dependency-graph.jsonl
//   DG2  addEdge with bad kind rejected with clear error
//   DG3  addEdge self-edge rejected
//   DG4  addEdge cycle detection: A->B then B->A rejected
//   DG5  wouldCreateCycle deep: A->B->C, probe C->A returns true
//   DG6  removeEdge happy path drops from listEdges + appends 'remove' log row
//   DG7  removeEdge unknown edge returns {ok:false}
//   DG8  isCyclic on clean DAG returns false
//   DG9  rebuildFromDisk replays add/remove ops + returns add count
//   DG10 getDependents transitive A->B->C: dependents of C = [A,B] (order-free)
//   DG11 getAncestors transitive A->B->C: ancestors of A = [B,C] (order-free)
//   DG12 decision-log appendDecision with depends_on creates edge
//   DG13 assumption-ledger appendAssumption with depends_on creates edge
//   DG14 backward-compat: legacy decision without depends_on still loads
//   DG15 Kill Watcher cascade: retract A (assumption) -> emit CASCADE_REVIEW for B, C
//   DG16 Cascade event shape: ts + action='CASCADE_REVIEW' + source_entry + cascade_entry + suggested_action
//   DG17 Cascade de-dup: 2nd sweep does NOT re-emit same (source,cascade) pair
//   DG18 Cascade does NOT mutate downstream entries (non-mutation contract)
//   DG19 Wikilink: lexical exact match wins over substring
//   DG20 Wikilink: frequency tie-breaks when lexical tied
//   DG21 Wikilink: neighborhood Jaccard lifts context-aligned candidate
//   DG22 Wikilink: lifecycle filter drops 'invalidated' / 'deprecated' by default
//
// Run: node app/scripts/_dev_verify_dependency_graph.js
// Exit 0 = PASS, 1 = any failure.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Route the vault to an isolated tmp dir so this smoke leaves zero footprint
// on the user vault. Must be set BEFORE requiring any vault-consuming module.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-dg-smoke-'));
process.env.HYPHA_DATA = TMP_ROOT;

const vault = require('../lib/vault');
const decisionLog = require('../lib/creation/decision-log');
const assumptionLedger = require('../lib/creation/assumption-ledger');
const killWatcher = require('../lib/creation/kill-watcher');
const dependencyGraph = require('../lib/creation/dependency-graph');
const wikilink = require('../lib/creation/wikilink-resolver');

const SLUG = '__verify_dependency_graph__';

const tests = [];
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  PASS  ${name}`); }
  else { failed++; tests.push(`  FAIL  ${name}${extra ? '\n        ' + extra : ''}`); }
}

function withSilentWarn(fn) {
  const orig = console.warn;
  console.warn = () => {};
  try { return fn(); }
  finally { console.warn = orig; }
}

function dateOffset(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function freshGraph() {
  // Wipe edge log + in-memory state between scenarios.
  const edgeLog = path.join(vault.resolveRoot(), '.hypha', 'dependency-graph.jsonl');
  if (fs.existsSync(edgeLog)) { try { fs.unlinkSync(edgeLog); } catch (_) {} }
  dependencyGraph._resetForTests();
}

function freshReviewAudit() {
  const abs = path.join(vault.resolveRoot(), '.hypha', 'kill-watcher.jsonl');
  if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (_) {} }
}

function cleanSlug() {
  const dir = path.join(vault.resolveRoot(), SLUG);
  if (!fs.existsSync(dir)) return;
  for (const f of ['decisions.jsonl', 'assumptions.jsonl', 'sparks.jsonl', 'decision-reviews.jsonl']) {
    const abs = path.join(dir, f);
    if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (_) {} }
  }
}

// ─── Setup ─────────────────────────────────────────────────────────────────
freshGraph();
freshReviewAudit();
cleanSlug();

// ─── DG1: addEdge happy path ───────────────────────────────────────────────
{
  freshGraph();
  const res = dependencyGraph.addEdge({ from_id: 'A', to_id: 'B', kind: 'depends_on' });
  check('DG1a addEdge returns ok', res && res.ok === true);
  const edges = dependencyGraph.listEdges();
  check('DG1b listEdges has 1 entry', edges.length === 1);
  check('DG1c edge shape correct',
    edges[0].from_id === 'A' && edges[0].to_id === 'B' && edges[0].kind === 'depends_on');
  const logAbs = path.join(vault.resolveRoot(), '.hypha', 'dependency-graph.jsonl');
  check('DG1d edge log file exists', fs.existsSync(logAbs));
  const logRaw = fs.readFileSync(logAbs, 'utf8').trim().split('\n');
  const logRow = JSON.parse(logRaw[0]);
  check('DG1e log row has op=add', logRow.op === 'add');
  check('DG1f log row has ts', typeof logRow.ts === 'string' && !Number.isNaN(Date.parse(logRow.ts)));
}

// ─── DG2: addEdge bad kind ─────────────────────────────────────────────────
{
  freshGraph();
  const res = dependencyGraph.addEdge({ from_id: 'A', to_id: 'B', kind: 'bogus' });
  check('DG2 bad kind rejected',
    res && res.ok === false && /kind must be one of/.test(res.error),
    `got: ${JSON.stringify(res)}`);
}

// ─── DG3: self-edge rejected ───────────────────────────────────────────────
{
  freshGraph();
  const res = dependencyGraph.addEdge({ from_id: 'X', to_id: 'X', kind: 'depends_on' });
  check('DG3 self-edge rejected',
    res && res.ok === false && /self-edge/.test(res.error),
    `got: ${JSON.stringify(res)}`);
}

// ─── DG4: cycle A->B, B->A ─────────────────────────────────────────────────
{
  freshGraph();
  dependencyGraph.addEdge({ from_id: 'A', to_id: 'B', kind: 'depends_on' });
  const res = dependencyGraph.addEdge({ from_id: 'B', to_id: 'A', kind: 'depends_on' });
  check('DG4 cycle rejected',
    res && res.ok === false && /cycle detected/.test(res.error),
    `got: ${JSON.stringify(res)}`);
}

// ─── DG5: deep cycle probe ─────────────────────────────────────────────────
{
  freshGraph();
  dependencyGraph.addEdge({ from_id: 'A', to_id: 'B', kind: 'depends_on' });
  dependencyGraph.addEdge({ from_id: 'B', to_id: 'C', kind: 'depends_on' });
  check('DG5a wouldCreateCycle deep C->A returns true',
    dependencyGraph.wouldCreateCycle('C', 'A') === true);
  check('DG5b wouldCreateCycle D->A returns false (D not connected)',
    dependencyGraph.wouldCreateCycle('D', 'A') === false);
}

// ─── DG6: removeEdge happy path ────────────────────────────────────────────
{
  freshGraph();
  dependencyGraph.addEdge({ from_id: 'A', to_id: 'B', kind: 'depends_on' });
  const rm = dependencyGraph.removeEdge({ from_id: 'A', to_id: 'B', kind: 'depends_on' });
  check('DG6a removeEdge ok', rm && rm.ok === true);
  check('DG6b listEdges empty after remove', dependencyGraph.listEdges().length === 0);
  const logAbs = path.join(vault.resolveRoot(), '.hypha', 'dependency-graph.jsonl');
  const lines = fs.readFileSync(logAbs, 'utf8').trim().split('\n');
  const lastOp = JSON.parse(lines[lines.length - 1]).op;
  check('DG6c last log op = remove', lastOp === 'remove');
}

// ─── DG7: removeEdge unknown ───────────────────────────────────────────────
{
  freshGraph();
  const rm = dependencyGraph.removeEdge({ from_id: 'X', to_id: 'Y', kind: 'depends_on' });
  check('DG7 unknown edge → ok:false',
    rm && rm.ok === false && /edge not found/.test(rm.error),
    `got: ${JSON.stringify(rm)}`);
}

// ─── DG8: isCyclic on DAG ──────────────────────────────────────────────────
{
  freshGraph();
  dependencyGraph.addEdge({ from_id: 'A', to_id: 'B', kind: 'depends_on' });
  dependencyGraph.addEdge({ from_id: 'A', to_id: 'C', kind: 'depends_on' });
  dependencyGraph.addEdge({ from_id: 'B', to_id: 'D', kind: 'depends_on' });
  dependencyGraph.addEdge({ from_id: 'C', to_id: 'D', kind: 'depends_on' });
  check('DG8 clean DAG isCyclic = false', dependencyGraph.isCyclic() === false);
}

// ─── DG9: rebuildFromDisk ──────────────────────────────────────────────────
{
  freshGraph();
  dependencyGraph.addEdge({ from_id: 'A', to_id: 'B', kind: 'depends_on' });
  dependencyGraph.addEdge({ from_id: 'B', to_id: 'C', kind: 'supports' });
  dependencyGraph.removeEdge({ from_id: 'A', to_id: 'B', kind: 'depends_on' });
  dependencyGraph._resetForTests();
  const count = dependencyGraph.rebuildFromDisk(vault.resolveRoot());
  // 2 adds in the log → count returns 2; remove drops one in-memory.
  check('DG9a rebuildFromDisk returns add count = 2', count === 2, `got: ${count}`);
  const live = dependencyGraph.listEdges();
  check('DG9b live edges after replay = 1 (B->C only)',
    live.length === 1 && live[0].from_id === 'B' && live[0].to_id === 'C',
    `got: ${JSON.stringify(live)}`);
}

// ─── DG10: getDependents transitive ────────────────────────────────────────
{
  freshGraph();
  // A depends_on B, B depends_on C. Dependents of C = [A,B].
  dependencyGraph.addEdge({ from_id: 'A', to_id: 'B', kind: 'depends_on' });
  dependencyGraph.addEdge({ from_id: 'B', to_id: 'C', kind: 'depends_on' });
  const dep = dependencyGraph.getDependents('C');
  check('DG10a getDependents(C) returns 2 entries', dep.length === 2, `got: ${JSON.stringify(dep)}`);
  check('DG10b dependents of C contain A + B',
    dep.includes('A') && dep.includes('B'),
    `got: ${JSON.stringify(dep)}`);
}

// ─── DG11: getAncestors transitive ─────────────────────────────────────────
{
  // Same chain. Ancestors of A = [B,C].
  const anc = dependencyGraph.getAncestors('A');
  check('DG11a getAncestors(A) returns 2 entries', anc.length === 2, `got: ${JSON.stringify(anc)}`);
  check('DG11b ancestors of A contain B + C',
    anc.includes('B') && anc.includes('C'),
    `got: ${JSON.stringify(anc)}`);
}

// ─── DG12: decision-log with depends_on ────────────────────────────────────
{
  freshGraph();
  cleanSlug();
  const first = decisionLog.appendDecision(SLUG, {
    lesson_idx: 0,
    decision: 'DG12 base decision providing foundation',
  });
  check('DG12a base decision append ok', first && first.ok === true);
  const baseTs = first.row.ts;
  const second = decisionLog.appendDecision(SLUG, {
    lesson_idx: 1,
    decision: 'DG12 downstream decision builds on base',
    depends_on: [baseTs],
  });
  check('DG12b downstream append ok', second && second.ok === true);
  check('DG12c row.depends_on persisted',
    Array.isArray(second.row.depends_on) && second.row.depends_on[0] === baseTs);
  const dep = dependencyGraph.getDependents(baseTs);
  check('DG12d edge materialised: getDependents(base) includes downstream ts',
    dep.includes(second.row.ts),
    `dep=${JSON.stringify(dep)} expected to include ${second.row.ts}`);
}

// ─── DG13: assumption-ledger with depends_on ───────────────────────────────
{
  // Reuse same SLUG; assumption appends additively.
  const baseAssum = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 0,
    claim: 'DG13 base assumption that downstream relies on',
    state: 'unvalidated',
  });
  check('DG13a base assumption append ok', baseAssum && baseAssum.ok === true);
  const baseId = baseAssum.row.assumption_id;
  const downstream = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 1,
    claim: 'DG13 downstream assumption depending on base',
    state: 'unvalidated',
    depends_on: [baseId],
  });
  check('DG13b downstream append ok', downstream && downstream.ok === true);
  check('DG13c depends_on persisted',
    Array.isArray(downstream.row.depends_on) && downstream.row.depends_on[0] === baseId);
  const dep = dependencyGraph.getDependents(baseId);
  check('DG13d edge present', dep.includes(downstream.row.assumption_id),
    `dep=${JSON.stringify(dep)}`);
}

// ─── DG14: backward-compat ─────────────────────────────────────────────────
{
  const legacy = decisionLog.appendDecision(SLUG, {
    lesson_idx: 0,
    decision: 'DG14 legacy decision without depends_on',
  });
  check('DG14a legacy append ok', legacy && legacy.ok === true);
  check('DG14b row has no depends_on field', legacy.row.depends_on === undefined);
  // List round-trip
  const list = decisionLog.listDecisions(SLUG);
  const found = list.find(r => r.decision === 'DG14 legacy decision without depends_on');
  check('DG14c legacy row round-trips', found && found.depends_on === undefined);
}

// ─── DG15-18: Cascade emission on retraction ───────────────────────────────
(async () => {
  freshGraph();
  freshReviewAudit();
  cleanSlug();
  const yesterday = dateOffset(-1);

  // Build chain: assumption A (past-deadline) <-depends_on- assumption B <-depends_on- assumption C
  const A = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 0,
    claim: 'DG15 root assumption with past deadline ≥10 chars',
    state: 'unvalidated',
    prediction: {
      claim: 'root claim that downstream B and C depend on',
      falsifier: 'fewer than 10 sign-ups by deadline 2026-05-19',
      deadline_iso: yesterday,
    },
  });
  check('DG15a root inject ok', A && A.ok === true);
  const aid = A.row.assumption_id;

  const B = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 1,
    claim: 'DG15 mid assumption depends on root ≥10 chars',
    state: 'unvalidated',
    depends_on: [aid],
  });
  check('DG15b mid inject ok', B && B.ok === true);
  const bid = B.row.assumption_id;

  const C = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 2,
    claim: 'DG15 leaf assumption depends on mid ≥10 chars',
    state: 'unvalidated',
    depends_on: [bid],
  });
  check('DG15c leaf inject ok', C && C.ok === true);
  const cid = C.row.assumption_id;

  // Confirm the graph thinks A's dependents are [B, C]
  const deps = dependencyGraph.getDependents(aid);
  check('DG15d dependency-graph sees both B and C as dependents of A',
    deps.includes(bid) && deps.includes(cid),
    `got: ${JSON.stringify(deps)}`);

  // Sweep — A's deadline passed, A unvalidated -> refuted; cascade emits to B + C.
  const sweep = await killWatcher.runKillWatcherSweep({ vaultRoot: vault.resolveRoot() });
  check('DG15e sweep ok', sweep && sweep.ok === true);

  const cascades = killWatcher.loadCascadeEvents();
  const forA = cascades.filter(r => r.source_entry === aid);
  check('DG15f exactly 2 CASCADE_REVIEW emitted for A',
    forA.length === 2,
    `got ${forA.length}: ${JSON.stringify(cascades)}`);
  const cascadeIds = new Set(forA.map(r => r.cascade_entry));
  check('DG15g cascades target both B and C',
    cascadeIds.has(bid) && cascadeIds.has(cid),
    `targets=${JSON.stringify(Array.from(cascadeIds))}`);

  // DG16: shape audit on first cascade
  const sample = forA[0];
  check('DG16a action = CASCADE_REVIEW', sample.action === 'CASCADE_REVIEW');
  check('DG16b ts is ISO', typeof sample.ts === 'string' && !Number.isNaN(Date.parse(sample.ts)));
  check('DG16c source_entry = A id', sample.source_entry === aid);
  check('DG16d source_kind = assumption', sample.source_kind === 'assumption');
  check('DG16e cascade_entry is in {bid, cid}',
    sample.cascade_entry === bid || sample.cascade_entry === cid);
  check('DG16f suggested_action = review_downstream',
    sample.suggested_action === 'review_downstream');
  check('DG16g reason includes "assumption_refuted"',
    typeof sample.reason === 'string' && sample.reason.includes('assumption_refuted'));

  // DG17: de-dup — 2nd sweep does NOT re-emit
  const beforeLen = killWatcher.loadCascadeEvents().length;
  const sweep2 = await killWatcher.runKillWatcherSweep({ vaultRoot: vault.resolveRoot() });
  check('DG17a 2nd sweep ok', sweep2 && sweep2.ok === true);
  const afterLen = killWatcher.loadCascadeEvents().length;
  check('DG17b cascade count unchanged after 2nd sweep',
    afterLen === beforeLen,
    `before=${beforeLen} after=${afterLen}`);

  // DG18: B and C are NOT auto-mutated — listAssumptions shows their original
  // claim text + their state remains 'unvalidated' (only A flips to 'refuted').
  const all = assumptionLedger.listAssumptions(SLUG);
  const bRow = all.find(r => r.assumption_id === bid);
  const cRow = all.find(r => r.assumption_id === cid);
  const aRow = all.find(r => r.assumption_id === aid);
  check('DG18a B claim unchanged',
    bRow && bRow.claim === 'DG15 mid assumption depends on root ≥10 chars');
  check('DG18b B state still unvalidated (not auto-mutated)',
    bRow && bRow.state === 'unvalidated');
  check('DG18c C state still unvalidated', cRow && cRow.state === 'unvalidated');
  check('DG18d A state IS refuted (the direct retraction path)',
    aRow && aRow.state === 'refuted');

  // ─── DG19-22: Wikilink resolver ──────────────────────────────────────────
  // DG19: lexical exact match
  {
    const candidates = [
      { id: '1', label: 'TypeScript', frequency: 100 },
      { id: '2', label: 'TypeScripts', frequency: 200 },
      { id: '3', label: 'TypeScript Compiler', frequency: 500 },
    ];
    const res = wikilink.resolveWikilink('TypeScript', candidates);
    check('DG19 lexical exact beats higher-frequency substring',
      res.match && res.match.id === '1',
      `match=${res.match && res.match.id} ranked=${JSON.stringify(res.ranked.map(r => [r.candidate.id, r.score.toFixed(3)]))}`);
  }

  // DG20: frequency tiebreak
  {
    const candidates = [
      { id: 'low',  label: 'foo bar baz', frequency: 1 },
      { id: 'high', label: 'foo bar qux', frequency: 1000 },
    ];
    const res = wikilink.resolveWikilink('foo bar', candidates);
    check('DG20 frequency tiebreak picks higher freq when lexical equal',
      res.match && res.match.id === 'high',
      `match=${res.match && res.match.id} ranked=${JSON.stringify(res.ranked.map(r => [r.candidate.id, r.score.toFixed(3)]))}`);
  }

  // DG21: neighborhood lift
  {
    const candidates = [
      { id: 'a', label: 'Markov', tags: ['stats', 'probability', 'chain'] },
      { id: 'b', label: 'Markov', tags: ['music', 'composer', 'russian'] },
    ];
    const res = wikilink.resolveWikilink('Markov', candidates, {
      contextTags: ['probability', 'stats', 'finance'],
    });
    check('DG21 neighborhood Jaccard tie-breaks identical lexical',
      res.match && res.match.id === 'a',
      `match=${res.match && res.match.id} ranked=${JSON.stringify(res.ranked.map(r => [r.candidate.id, r.evidence.neighborhood.toFixed(2)]))}`);
  }

  // DG22: lifecycle filter
  {
    const candidates = [
      { id: 'live',     label: 'Concept', lifecycle: 'ratified' },
      { id: 'dead',     label: 'Concept', lifecycle: 'invalidated' },
      { id: 'sunset',   label: 'Concept', lifecycle: 'deprecated' },
    ];
    const res = wikilink.resolveWikilink('Concept', candidates);
    check('DG22a default filter drops invalidated + deprecated',
      res.filteredOut.length === 2, `filteredOut=${JSON.stringify(res.filteredOut.map(c => c.id))}`);
    check('DG22b match is the ratified one', res.match && res.match.id === 'live');
    const resAll = wikilink.resolveWikilink('Concept', candidates, { lifecycleFilter: 'all' });
    check('DG22c lifecycleFilter=all keeps all 3', resAll.ranked.length === 3);
  }

  // ─── Done ─────────────────────────────────────────────────────────────────
  console.log('\nHYPHA · dependency-graph + wikilink smoke');
  console.log('-----------------------------------------------');
  for (const line of tests) console.log(line);
  console.log('-----------------------------------------------');
  console.log(`PASSED: ${passed}  FAILED: ${failed}  TOTAL: ${passed + failed}`);
  console.log(`tmp vault: ${TMP_ROOT}`);

  // Print a sample cascade event for human inspection (matches deliverable #2)
  const sampleCascade = killWatcher.loadCascadeEvents()[0];
  if (sampleCascade) {
    console.log('\nsample CASCADE_REVIEW event:');
    console.log(JSON.stringify(sampleCascade, null, 2));
  }

  // Best-effort tmp cleanup.
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => {
  console.error('[verify] uncaught: ' + (err && err.stack ? err.stack : err));
  process.exit(2);
});
