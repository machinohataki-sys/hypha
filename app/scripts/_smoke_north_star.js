'use strict';

// HYPHA · 阶 3 北极星 smoke test (2026-05-17).
//
// 走通最小路径:
//   1. set HYPHA_DATA to a temp dir
//   2. addConcept × 3
//   3. transitionConcept × 1 (draft → review)
//   4. getNorthStar → 期望 draft_on_deck=3 (2 draft + 1 review), ratified=0
//   5. countByState → 期望 {draft:2, review:1, ratified:0, superseded:0, deprecated:0}
//   6. listConcepts({stateFilter:'review'}) → 1 hit
//   7. transitionConcept(review → ratified) → 期望 ratified=1
//   8. INVALID_TRANSITION smoke: draft → ratified 必须 fail
//   9. pickNextLesson on empty mastery → 不 throw, 返回 candidate
//
// Run:
//   node E:\victor\hypha\app\scripts\_smoke_north_star.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point HYPHA_DATA to a fresh tmp dir BEFORE requiring any vault-aware module.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-northstar-smoke-'));
process.env.HYPHA_DATA = TMP_ROOT;

const conceptLifecycle = require('../lib/lesson-system/concept-lifecycle');
const northStar = require('../lib/growth/north-star-metrics');
const banditFrontier = require('../lib/growth/bandit-frontier');

const SLUG = 'smoke-test-slug';

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('  PASS  ' + label);
  } else {
    failed += 1;
    failures.push({ label, detail });
    console.log('  FAIL  ' + label + '  ' + (detail || ''));
  }
}

async function main() {
  console.log('北极星 smoke test  tmp=' + TMP_ROOT);

  // Step 2: add 3 concepts
  const c1 = await conceptLifecycle.addConcept({
    slug: SLUG,
    name: 'transformer-attention',
    source_lesson_idx: 0,
  });
  const c2 = await conceptLifecycle.addConcept({
    slug: SLUG,
    name: 'kv-cache',
    source_lesson_idx: 1,
  });
  const c3 = await conceptLifecycle.addConcept({
    slug: SLUG,
    name: 'rotary-embedding',
    source_lesson_idx: 2,
    evidence_lesson_idxs: [1, 2],
  });
  check('addConcept × 3 all ok',
    c1.ok && c2.ok && c3.ok,
    JSON.stringify({ c1: c1.ok, c2: c2.ok, c3: c3.ok }));
  check('addConcept returns conceptId',
    typeof c1.concept?.conceptId === 'string' && c1.concept.conceptId.length > 0);
  check('addConcept default state = draft',
    c1.concept?.state === 'draft');

  // Step 3: 1 transition draft → review
  const t1 = await conceptLifecycle.transitionConcept({
    slug: SLUG,
    conceptId: c1.concept.conceptId,
    newState: 'review',
  });
  check('transitionConcept draft→review ok', t1.ok && t1.concept?.state === 'review');

  // Step 4: getNorthStar
  const ns = await northStar.getNorthStar({ slug: SLUG });
  check('getNorthStar ok', ns.ok);
  check('north-star ratified=0', ns.metrics?.ratified === 0,
    'got=' + ns.metrics?.ratified);
  check('north-star draft_on_deck=3 (2 draft + 1 review)',
    ns.metrics?.draft_on_deck === 3,
    'got=' + ns.metrics?.draft_on_deck);
  check('north-star artifacts_shipped=0', ns.metrics?.artifacts_shipped === 0);
  check('north-star spark_matured=0', ns.metrics?.spark_matured === 0);
  check('recent_transitions includes draft→review',
    Array.isArray(ns.recent_transitions)
    && ns.recent_transitions.some(t => t.from === 'draft' && t.to === 'review'));

  // Step 5: countByState
  const cb = await conceptLifecycle.countByState({ slug: SLUG });
  check('countByState ok', cb.ok);
  check('countByState draft=2', cb.counts?.draft === 2, 'got=' + cb.counts?.draft);
  check('countByState review=1', cb.counts?.review === 1, 'got=' + cb.counts?.review);
  check('countByState ratified=0', cb.counts?.ratified === 0);

  // Step 6: listConcepts stateFilter review
  const lr = await conceptLifecycle.listConcepts({ slug: SLUG, stateFilter: 'review' });
  check('listConcepts(review) returns 1', lr.ok && lr.concepts?.length === 1);

  // Step 7: review → ratified
  const t2 = await conceptLifecycle.transitionConcept({
    slug: SLUG,
    conceptId: c1.concept.conceptId,
    newState: 'ratified',
  });
  check('transitionConcept review→ratified ok',
    t2.ok && t2.concept?.state === 'ratified');

  const ns2 = await northStar.getNorthStar({ slug: SLUG });
  check('north-star after ratify: ratified=1',
    ns2.metrics?.ratified === 1, 'got=' + ns2.metrics?.ratified);
  check('north-star after ratify: draft_on_deck=2',
    ns2.metrics?.draft_on_deck === 2, 'got=' + ns2.metrics?.draft_on_deck);

  // Step 8: INVALID_TRANSITION (draft → ratified directly)
  const bad = await conceptLifecycle.transitionConcept({
    slug: SLUG,
    conceptId: c2.concept.conceptId,
    newState: 'ratified',  // c2 is still draft — illegal jump
  });
  check('INVALID_TRANSITION blocks draft→ratified',
    !bad.ok && bad.error === 'INVALID_TRANSITION',
    'got=' + JSON.stringify(bad));

  // CONCEPT_NOT_FOUND smoke
  const notFound = await conceptLifecycle.transitionConcept({
    slug: SLUG,
    conceptId: 'nope-' + Date.now(),
    newState: 'review',
  });
  check('CONCEPT_NOT_FOUND surfaces',
    !notFound.ok && notFound.error === 'CONCEPT_NOT_FOUND');

  // MISSING_SLUG smoke
  const noSlug = await conceptLifecycle.addConcept({ name: 'x' });
  check('MISSING_SLUG on addConcept',
    !noSlug.ok && noSlug.error === 'MISSING_SLUG');

  // Step 9: bandit-frontier picks something
  const pick = await banditFrontier.pickNextLesson({ slug: SLUG });
  check('bandit-frontier.pick ok', pick.ok);
  check('bandit-frontier returns concept name',
    typeof pick.concept === 'string' && pick.concept.length > 0,
    'got=' + JSON.stringify(pick));
  check('bandit-frontier reason is non-empty string',
    typeof pick.reason === 'string' && pick.reason.length > 0);

  // empty-state smoke: brand-new slug
  const emptyPick = await banditFrontier.pickNextLesson({ slug: 'no-such-slug-' + Date.now() });
  check('bandit-frontier empty slug returns concept=null',
    emptyPick.ok && emptyPick.concept === null);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('TOTAL  passed=' + passed + '  failed=' + failed);
  if (failed > 0) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f.label + (f.detail ? '  ' + f.detail : ''));
    console.log('\nRESULT: FAIL');
    process.exitCode = 1;
  } else {
    console.log('RESULT: PASS');
  }

  // Cleanup tmp
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
}

main().catch(err => {
  console.error('SMOKE THREW:', err);
  process.exitCode = 2;
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) {}
});
