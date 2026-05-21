'use strict';

// HYPHA · Note System v2 smoke — pushes deliverables from rc.1 ~88% to ~95%.
//
// Coverage matrix (15 tests, deliverables D1-D5 + smoke D6):
//   D1 Dual-layer distill provenance trace ......... T01 T02 T03
//   D2 Living Note reactivation confidence bands ... T04 T05 T06 T07
//   D3 Web Note Engine 5 typed edges completeness .. T08 T09 T10
//   D4 Atlas concept temporal decay + archive ...... T11 T12 T13
//   D5 Entropy reduction quantification ............ T14 T15 T16
//
// Runs offline — no LLM. Each LLM-touching path is exercised via dependency
// injection (_executeChat / _indexShim). vault writes go to a sandbox tempdir
// keyed by HYPHA_DATA so production vault is never touched.

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const SLUG = 'note-v2-smoke';

let _pass = 0;
let _fail = 0;
const _fails = [];

function ok(name, cond, detail) {
  if (cond) {
    _pass++;
    console.log(`PASS ${name}` + (detail ? ` — ${detail}` : ''));
  } else {
    _fail++;
    _fails.push(name);
    console.error(`FAIL ${name}` + (detail ? ` — ${detail}` : ''));
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

function withTempVault() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-note-v2-'));
  process.env.HYPHA_DATA = base;
  process.env.HYPHA_VAULT_DIR = base;
  process.env.HYPHA_VAULT_ROOT = base;
  return base;
}

function rmRf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// D1 — Dual-layer distill provenance
// ---------------------------------------------------------------------------

async function testD1(vault) {
  const ln = require('../lib/lesson-note');
  // T01: buildFrontmatter emits distill_provenance when given
  const fm = ln.buildFrontmatter({
    plan: { hook_concrete: 'x' },
    scoreResult: { passed: true },
    goalContract: { north_star_goal: 'g', main_creation: 'mc' },
    lessonId: 1,
    generatedAt: '2026-05-21T00:00:00Z',
    provenance: {
      from_lesson_ids: [0, 2, 3],
      from_user_sparks: ['spark-a', 'spark-b'],
      at_ts: '2026-05-20T12:00:00Z',
    },
  });
  ok('T01 buildFrontmatter contains distill_provenance', /distill_provenance:/.test(fm));

  // T02: provenance round-trips through parseDistillProvenance
  const m = fm.match(/^distill_provenance:\s*(.+)$/m);
  ok('T02a distill_provenance row found', !!m);
  const parsed = ln.parseDistillProvenance(m && m[1]);
  ok('T02 parseDistillProvenance round-trip',
    parsed && Array.isArray(parsed.from_lesson_ids) && parsed.from_lesson_ids.length === 3 &&
    Array.isArray(parsed.from_user_sparks) && parsed.from_user_sparks.length === 2 &&
    parsed.at_ts === '2026-05-20T12:00:00Z',
    JSON.stringify(parsed));

  // T03: omitted when caller does not pass provenance (backward compat)
  const fm2 = ln.buildFrontmatter({
    plan: { hook_concrete: 'x' },
    scoreResult: { passed: true },
    goalContract: { north_star_goal: 'g', main_creation: 'mc' },
    lessonId: 1,
    generatedAt: '2026-05-21T00:00:00Z',
  });
  ok('T03 backward compat — no provenance row when absent', !/distill_provenance:/.test(fm2));
}

// ---------------------------------------------------------------------------
// D2 — Living Note reactivation confidence
// ---------------------------------------------------------------------------

async function testD2(vault) {
  const lr = require('../lib/note-system/living-reactivation');

  // T04: classifier — high band requires high jaccard + LLM agree
  const c1 = lr._classifyConfidence({ jaccard: 0.8, llmAgreed: true });
  eq('T04a high band returns high', c1.band, 'high');
  const c2 = lr._classifyConfidence({ jaccard: 0.8, llmAgreed: false });
  eq('T04b high jaccard but LLM dropped → medium', c2.band, 'medium');

  // T05: classifier — mid band
  const c3 = lr._classifyConfidence({ jaccard: 0.6, llmAgreed: true });
  eq('T05a 0.5≤j<0.7 → medium', c3.band, 'medium');
  const c4 = lr._classifyConfidence({ jaccard: 0.3, llmAgreed: true });
  eq('T05b j<0.5 → low', c4.band, 'low');

  // T06: full pipeline emits confidence on candidates + writes log
  // Build a slug dir with 3 lesson notes: 2 highly similar + 1 unrelated.
  const slugDir = path.join(vault, SLUG);
  fs.mkdirSync(slugDir, { recursive: true });
  const PAD = ' '.repeat(900); // exceed MIN_NOTE_BYTES floor
  fs.writeFileSync(path.join(slugDir, 'lesson-1.md'),
    `---\ntitle: alpha\n---\n# alpha\n哲学 思考 自由 意志 ${PAD}`, 'utf8');
  // Backdate so DEFAULT_MIN_AGE_DAYS=7 doesn't filter it.
  const old = Date.now() - 30 * 86400 * 1000;
  fs.utimesSync(path.join(slugDir, 'lesson-1.md'), old / 1000, old / 1000);

  fs.writeFileSync(path.join(slugDir, 'lesson-2.md'),
    `---\ntitle: beta\n---\n# beta\n哲学 思考 自由 道德 ${PAD}`, 'utf8');
  fs.utimesSync(path.join(slugDir, 'lesson-2.md'), old / 1000, old / 1000);

  fs.writeFileSync(path.join(slugDir, 'lesson-3.md'),
    `---\ntitle: gamma\n---\n# gamma\n物理 力学 牛顿 加速度 ${PAD}`, 'utf8');
  fs.utimesSync(path.join(slugDir, 'lesson-3.md'), old / 1000, old / 1000);

  // Fake LLM that always agrees with first candidate by jaccard.
  const fakeExecuteChat = async (cap, args) => {
    return { result: { selected: [{ note_idx: 1, reason: 'topic match', transfer_point: 'use here', rank: 1 }] } };
  };

  const out = await lr.findReactivationCandidates({
    slug: SLUG,
    currentLessonIdx: 99,
    currentLessonText: '哲学 思考 自由 意志 决定论',
    opts: { minAgeDays: 0, _executeChat: fakeExecuteChat },
  });

  ok('T06a candidates returned with confidence band',
    Array.isArray(out.candidates) && out.candidates.length > 0 &&
    ['high', 'medium', 'low'].includes(out.candidates[0].confidence),
    `count=${out.candidates.length} band=${out.candidates[0] && out.candidates[0].confidence}`);

  ok('T06b summary tracks confidence_counts',
    out.summary && out.summary.confidence_counts &&
    typeof out.summary.confidence_counts.high === 'number' &&
    typeof out.summary.confidence_counts.medium === 'number' &&
    typeof out.summary.confidence_counts.low === 'number',
    JSON.stringify(out.summary.confidence_counts));

  // T07: reactivation-log.jsonl was written under vault/.hypha/
  const logPath = path.join(vault, '.hypha', 'reactivation-log.jsonl');
  ok('T07a reactivation-log.jsonl exists', fs.existsSync(logPath), logPath);
  const logRaw = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const logRows = logRaw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  ok('T07b log rows have required fields',
    logRows.length > 0 &&
    logRows.every(r => r.ts && r.slug && typeof r.candidate_lesson_idx === 'number' &&
                       ['high', 'medium', 'low'].includes(r.confidence) &&
                       typeof r.confidence_reason === 'string'),
    `rows=${logRows.length}`);
  ok('T07c summary log_rows_written matches reality',
    out.summary.log_rows_written === logRows.length,
    `summary=${out.summary.log_rows_written} actual=${logRows.length}`);

  // Sample for final report
  global.__sampleReactivationRow = logRows[0];
}

// ---------------------------------------------------------------------------
// D3 — Web Note Engine 5 typed edges completeness
// ---------------------------------------------------------------------------

async function testD3(vault) {
  const wne = require('../lib/note-system/web-note-engine');
  const EXPECTED = ['cites', 'contradicts', 'extends', 'triggered-by', 'related'];

  // T08: EDGE_TYPES contains exactly the 5 spec edges (frozen + complete)
  ok('T08a EDGE_TYPES has 5 entries', Array.isArray(wne.EDGE_TYPES) && wne.EDGE_TYPES.length === 5);
  ok('T08b EDGE_TYPES matches spec set',
    EXPECTED.every(t => wne.EDGE_TYPES.includes(t)) &&
    wne.EDGE_TYPES.every(t => EXPECTED.includes(t)),
    `got=${JSON.stringify(wne.EDGE_TYPES)}`);
  ok('T08c EDGE_TYPES is frozen', Object.isFrozen(wne.EDGE_TYPES));

  // T09: addEdge accepts each of the 5 types + listEdges replays them
  const sl = 'note-v2-edges';
  fs.mkdirSync(path.join(vault, sl), { recursive: true });
  let allAddedOk = true;
  for (let i = 0; i < EXPECTED.length; i++) {
    const r = wne.addEdge(sl, { from_idx: 10 + i, to_idx: 20 + i, type: EXPECTED[i], evidence: `e-${i}` });
    if (!r.ok) allAddedOk = false;
  }
  ok('T09a addEdge accepts all 5 types', allAddedOk);
  const edges = wne.listEdges(sl);
  const seenTypes = new Set(edges.map(e => e.type));
  ok('T09b listEdges replays all 5', EXPECTED.every(t => seenTypes.has(t)), `seen=${[...seenTypes]}`);

  // T10: validator rejects unknown type + self-edge
  const bad = wne.addEdge(sl, { from_idx: 1, to_idx: 2, type: 'supports' });
  ok('T10a unknown type rejected (e.g. supports — common spec confusion)',
    !bad.ok && /type must be one of/.test(bad.error));
  const self = wne.addEdge(sl, { from_idx: 1, to_idx: 1, type: 'cites' });
  ok('T10b self-edge rejected', !self.ok && /self-edge/.test(self.error));
}

// ---------------------------------------------------------------------------
// D4 — Atlas concept temporal decay
// ---------------------------------------------------------------------------

async function testD4(vault) {
  const ad = require('../lib/note-system/atlas-decay');

  // T11: half-life decay math — one visit at exactly halfLife ago → 0.5
  const now = 1_700_000_000_000;
  const halfLifeDays = 90;
  const oneHalfLifeAgo = now - halfLifeDays * 86400 * 1000;
  const w = ad.decayedWeight([oneHalfLifeAgo], { nowMs: now, halfLifeDays });
  ok('T11a decayedWeight after 1 half-life ≈ 0.5',
    Math.abs(w - 0.5) < 1e-6, `w=${w}`);

  const wFresh = ad.decayedWeight([now], { nowMs: now, halfLifeDays });
  ok('T11b decayedWeight at t=now ≈ 1.0', Math.abs(wFresh - 1.0) < 1e-6, `w=${wFresh}`);

  const wEmpty = ad.decayedWeight([], { nowMs: now, halfLifeDays });
  eq('T11c empty timeline → 0', wEmpty, 0);

  // T12: applyHalfLifeDecay across a concept map
  const timeline = {
    fresh: [now - 1 * 86400 * 1000],                                              // 1 day → ~0.99
    moderate: [now - 90 * 86400 * 1000],                                          // 90 d → 0.5
    stale: [now - 360 * 86400 * 1000],                                            // 360 d → ~0.0625
    multi: [now - 1 * 86400 * 1000, now - 90 * 86400 * 1000],                    // sum ≈ 1.49
  };
  const { weights, lastTouched } = ad.applyHalfLifeDecay(timeline, { nowMs: now, halfLifeDays });
  ok('T12a fresh > moderate > stale',
    weights.fresh > weights.moderate && weights.moderate > weights.stale,
    `fresh=${weights.fresh} moderate=${weights.moderate} stale=${weights.stale}`);
  ok('T12b multi-visit > single fresh',
    weights.multi > weights.fresh,
    `multi=${weights.multi} fresh=${weights.fresh}`);
  ok('T12c lastTouched captures max ts',
    lastTouched.multi === now - 1 * 86400 * 1000,
    `lt=${lastTouched.multi}`);

  // T13: archiveBelowThreshold writes archive jsonl and reads back
  const sl = 'note-v2-atlas';
  // Stale concept (0.0625) is below 0.1 floor → archived
  const archRes = ad.archiveBelowThreshold({
    slug: sl,
    conceptTimeline: timeline,
    nowMs: now,
    halfLifeDays,
    archiveFloor: 0.1,
    reason: 'smoke-test',
  });
  ok('T13a archiveBelowThreshold ok', archRes.ok);
  ok('T13b stale concept archived', archRes.archived.includes('stale'), `archived=${JSON.stringify(archRes.archived)}`);
  ok('T13c fresh + moderate NOT archived',
    !archRes.archived.includes('fresh') && !archRes.archived.includes('moderate'));

  const replayed = ad.readArchive(sl);
  ok('T13d readArchive returns appended rows',
    replayed.length === archRes.archived.length,
    `replayed=${replayed.length} written=${archRes.archived.length}`);
  ok('T13e archive row has required fields',
    replayed[0] && replayed[0].ts && replayed[0].concept &&
    typeof replayed[0].weight_at_archive === 'number' &&
    replayed[0].reason === 'smoke-test');
}

// ---------------------------------------------------------------------------
// D5 — Entropy reduction quantification
// ---------------------------------------------------------------------------

async function testD5() {
  const ad = require('../lib/note-system/atlas-decay');

  // T14: Shannon entropy basics
  eq('T14a entropy of empty counts = 0', ad.shannonEntropy({}), 0);
  eq('T14b entropy of single-bin = 0', ad.shannonEntropy({ a: 5 }), 0);

  // Uniform across 4 bins → entropy = log2(4) = 2.0 exactly
  const hUniform = ad.shannonEntropy({ a: 3, b: 3, c: 3, d: 3 });
  ok('T14c uniform 4-bin entropy = 2.0 bits', Math.abs(hUniform - 2.0) < 1e-9, `h=${hUniform}`);

  // Skewed distribution has lower entropy than uniform of same support
  const hSkewed = ad.shannonEntropy({ a: 10, b: 1, c: 1, d: 1 });
  ok('T14d skewed entropy < uniform entropy (same support)',
    hSkewed < hUniform, `skewed=${hSkewed} uniform=${hUniform}`);

  // T15: entropyBadge with synthetic week-over-week shift
  const now = 1_700_000_000_000;
  const day = 86400 * 1000;
  // Prior week (8-14 days ago): broad spread across 4 concepts
  // Current week (0-7 days ago): focused on 1 concept
  const timelineConverge = {
    a: [
      // prior: 4 visits in days 8-14
      now - 10 * day, now - 11 * day, now - 12 * day, now - 13 * day,
      // current: 8 visits in days 1-7
      now - 1 * day, now - 1 * day, now - 2 * day, now - 3 * day,
      now - 4 * day, now - 5 * day, now - 6 * day, now - 7 * day,
    ],
    b: [now - 10 * day],   // prior only
    c: [now - 11 * day],   // prior only
    d: [now - 12 * day],   // prior only
  };
  const badge1 = ad.entropyBadge({ conceptTimeline: timelineConverge, nowMs: now });
  eq('T15a convergence badge fires when current week is narrower', badge1.badge, 'convergence');
  ok('T15b convergence delta is negative', badge1.delta < 0, `delta=${badge1.delta}`);

  // Inverse: prior focused, current broad → divergence
  const timelineDiverge = {
    a: [now - 1 * day, now - 8 * day, now - 9 * day, now - 10 * day],
    b: [now - 2 * day],
    c: [now - 3 * day],
    d: [now - 4 * day],
  };
  const badge2 = ad.entropyBadge({ conceptTimeline: timelineDiverge, nowMs: now });
  eq('T15c divergence badge fires when current week broader', badge2.badge, 'divergence');

  // T16: insufficient_data when one window empty
  const timelineSparse = {
    a: [now - 1 * day], // only current week
  };
  const badge3 = ad.entropyBadge({ conceptTimeline: timelineSparse, nowMs: now });
  eq('T16 insufficient_data when prior week empty', badge3.badge, 'insufficient_data');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  const vault = withTempVault();
  try {
    await testD1(vault);
    await testD2(vault);
    await testD3(vault);
    await testD4(vault);
    await testD5();

    console.log('');
    console.log(`Total: ${_pass + _fail}  PASS: ${_pass}  FAIL: ${_fail}`);
    if (global.__sampleReactivationRow) {
      console.log('Sample reactivation-log row:');
      console.log(JSON.stringify(global.__sampleReactivationRow, null, 2));
    }
    if (_fail > 0) {
      console.error('Failed tests:', _fails.join(', '));
      process.exit(1);
    }
  } finally {
    rmRf(vault);
  }
})().catch((err) => {
  console.error('SMOKE EXCEPTION', err && err.stack || err);
  process.exit(2);
});
