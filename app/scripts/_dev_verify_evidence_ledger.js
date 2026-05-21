#!/usr/bin/env node
'use strict';

// HYPHA — Evidence Ledger v1.0 smoke (boot-9, 2026-05-20).
//
// Per-claim provenance for the v0.2 lesson body. Tests both the new module
// (app/lib/anti-slop/evidence-ledger.js) + the validateBodyV2 hook in
// lesson-body-generator.js + the LLM prompt directive + the coverage roll-up.
//
// Tests:
//   EL1: enumerateClaimIds on a synthetic body — deterministic + skips empty
//   EL2: buildLedger reads claims + evidence_refs into Map
//   EL3: computeClaimGrounding monotonic with grounded claim count
//   EL4: validateEvidenceRefs flags source_id not in evidence_cite[]
//   EL5: validateEvidenceRefs flags malformed refs (bad kind / bad weight / bad prefix)
//   EL6: detectOrphanClaims returns claims with zero refs
//   EL7: aggregateSourceUsage groups by source_id
//   EL8: validateBodyV2 with valid evidence_ledger PASS
//   EL9: validateBodyV2 with missing evidence_ledger PASS (backward-compat)
//   EL10: validateBodyV2 with malformed evidence_ledger (string) FAIL gracefully
//   EL11: LLM prompt mentions evidence_ledger directive (grep test)
//   EL12: End-to-end synthetic body 5 claims (3 grounded, 2 orphan) → grounding=60%
//   EL13: collectAvailableSourceIds reads book + pack + url shapes
//   EL14: summarize() returns frozen object with expected fields
//
// Run: node app/scripts/_dev_verify_evidence_ledger.js
// Exit 0 = PASS, exit 1 = any failure.

const el = require('../lib/anti-slop/evidence-ledger');
const lbg = require('../lib/lesson-body-generator');
const coverage = require('../lib/citation-system/coverage');

const {
  enumerateClaimIds,
  buildLedger,
  computeClaimGrounding,
  collectAvailableSourceIds,
  validateEvidenceRefs,
  detectOrphanClaims,
  aggregateSourceUsage,
  summarize,
  VALID_KINDS,
  SOURCE_ID_PREFIXES,
} = el;

const tests = [];
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  PASS  ${name}`); }
  else { failed++; tests.push(`  FAIL  ${name}${extra ? '\n        ' + extra : ''}`); }
}

// Reusable synthetic body w/ structural claims + evidence_cite[] + evidence_ledger[].
function makeBody(opts = {}) {
  const evCite = opts.evidence_cite !== undefined ? opts.evidence_cite : [
    { cite_type: 'library', book_id: 'abc123', chunk_idx: 7, book_title: 'Test Book', snippet: '...' },
    { cite_type: 'community', pack_id: 'spinoza-zh', snippet: '...' },
  ];
  const body = {
    thesis: 'The learner will see that substance is causa-sui',
    canonical_example: 'Spinoza Ethics Part I prop 7 — substance must exist',
    mechanism_explanation: 'Substance precedes attributes because the prior cannot be conceived through the posterior.',
    common_misconceptions: [
      'Substance is a thing (no — it is the only thing).',
      'Spinoza is a pantheist (contested — Deus sive Natura ≠ panentheism).',
    ],
    examples: [
      { claim: 'God-thinking attribute', example: '...' },
      'Body-extension attribute',
    ],
    exit_proof: 'Apply substance/attribute distinction to a new philosopher case.',
    note_connection: 'Builds on lesson-0 Descartes substance dualism.',
    jargon_list: [],
    evidence_cite: evCite,
  };
  if (opts.evidence_ledger !== undefined) body.evidence_ledger = opts.evidence_ledger;
  if (opts.sources) body.sources = opts.sources;
  return body;
}

// ─── EL1: enumerateClaimIds deterministic + skips empty ────────────────────
{
  const ids = enumerateClaimIds(makeBody());
  check('EL1a includes thesis', ids.includes('thesis'));
  check('EL1b includes mechanism', ids.includes('mechanism'));
  check('EL1c includes canonical_example', ids.includes('canonical_example'));
  check('EL1d includes misconception_0 + misconception_1', ids.includes('misconception_0') && ids.includes('misconception_1'));
  check('EL1e includes example_0 + example_1', ids.includes('example_0') && ids.includes('example_1'));

  // Empty body → empty ids
  check('EL1f null body → []', enumerateClaimIds(null).length === 0);
  check('EL1g {} body → []', enumerateClaimIds({}).length === 0);

  // Whitespace-only thesis skipped
  const bodyWS = makeBody();
  bodyWS.thesis = '   ';
  const idsWS = enumerateClaimIds(bodyWS);
  check('EL1h whitespace-only thesis skipped', !idsWS.includes('thesis'));
}

// ─── EL2: buildLedger reads claims + evidence_refs ─────────────────────────
{
  const body = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:abc123:7', weight: 0.9, kind: 'direct' }] },
      { claim_id: 'mechanism', evidence_refs: [{ source_id: 'pack:spinoza-zh', weight: 0.7, kind: 'corroborating' }] },
    ],
  });
  const ledger = buildLedger({ lessonBody: body });
  check('EL2a ledger size = 2', ledger.size === 2);
  check('EL2b thesis ref present', ledger.get('thesis') && ledger.get('thesis').length === 1);
  check('EL2c mechanism ref kind=corroborating', ledger.get('mechanism')[0].kind === 'corroborating');
  // Malformed rows silently skipped
  const body2 = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:abc123:7' }] },
      null,
      { claim_id: '', evidence_refs: [] },
      { evidence_refs: [] }, // missing claim_id
      { claim_id: 'orphan', evidence_refs: 'not-an-array' },
    ],
  });
  const ledger2 = buildLedger({ lessonBody: body2 });
  check('EL2d malformed rows silently skipped', ledger2.size === 1 && ledger2.has('thesis'));
}

// ─── EL3: computeClaimGrounding monotonic with grounded count ──────────────
{
  // 6 structural claims: thesis, mechanism, canonical_example, misconception_0, misconception_1, example_0, example_1
  // (example_0 has claim field; example_1 is a string)
  // Total: 7 claim ids. Ground 3 → grounding = 3/7 ≈ 0.4286
  const baseBody = makeBody();
  const ids = enumerateClaimIds(baseBody);
  check('EL3a base body has 7 claim ids', ids.length === 7, `got ${ids.length}: ${JSON.stringify(ids)}`);

  const ground3 = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:abc123:7' }] },
      { claim_id: 'mechanism', evidence_refs: [{ source_id: 'pack:spinoza-zh' }] },
      { claim_id: 'misconception_0', evidence_refs: [{ source_id: 'book:abc123:7' }] },
    ],
  });
  const g3 = computeClaimGrounding({ lessonBody: ground3 });
  check('EL3b grounding 3/7 ≈ 0.4286', Math.abs(g3 - (3 / 7)) < 0.001, `got ${g3}`);

  const ground5 = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:abc123:7' }] },
      { claim_id: 'mechanism', evidence_refs: [{ source_id: 'pack:spinoza-zh' }] },
      { claim_id: 'canonical_example', evidence_refs: [{ source_id: 'book:abc123:7' }] },
      { claim_id: 'misconception_0', evidence_refs: [{ source_id: 'book:abc123:7' }] },
      { claim_id: 'example_0', evidence_refs: [{ source_id: 'pack:spinoza-zh' }] },
    ],
  });
  const g5 = computeClaimGrounding({ lessonBody: ground5 });
  check('EL3c grounding monotonic (5 > 3)', g5 > g3, `g3=${g3} g5=${g5}`);

  const noLedger = makeBody();
  check('EL3d no ledger → grounding 0', computeClaimGrounding({ lessonBody: noLedger }) === 0);

  // Vacuous: no claims → grounding 1
  check('EL3e empty body → grounding 1', computeClaimGrounding({ lessonBody: {} }) === 1);
}

// ─── EL4: validateEvidenceRefs flags source_id not in evidence_cite[] ──────
{
  const body = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:abc123:7' }] },  // valid
      { claim_id: 'mechanism', evidence_refs: [{ source_id: 'book:ghostbook:99' }] }, // dangling
      { claim_id: 'misconception_0', evidence_refs: [{ source_id: 'url:https://example.com/x' }] }, // dangling
    ],
  });
  const errs = validateEvidenceRefs({ lessonBody: body });
  check('EL4a flags 2 dangling refs', errs.length === 2, `got ${errs.length}: ${JSON.stringify(errs)}`);
  check('EL4b flags ghostbook', errs.some(e => e.source_id === 'book:ghostbook:99'));
  check('EL4c flags ghost url', errs.some(e => e.source_id === 'url:https://example.com/x'));
}

// ─── EL5: validateEvidenceRefs flags malformed refs ───────────────────────
{
  const body = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'badprefix:xyz' }] },           // bad prefix
      { claim_id: 'mechanism', evidence_refs: [{ source_id: 'book:abc123:7', kind: 'bogus' }] }, // bad kind
      { claim_id: 'misconception_0', evidence_refs: [{ source_id: 'book:abc123:7', weight: 2.5 }] }, // bad weight
      { claim_id: 'misconception_1', evidence_refs: [{ }] }, // missing source_id
    ],
  });
  const errs = validateEvidenceRefs({ lessonBody: body });
  check('EL5a flags all 4 malformed refs', errs.length >= 4, `got ${errs.length}: ${JSON.stringify(errs)}`);
  check('EL5b malformed marker present', errs.some(e => /malformed/.test(e.reason)));
}

// ─── EL6: detectOrphanClaims returns claims with zero refs ────────────────
{
  const body = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:abc123:7' }] },
      { claim_id: 'mechanism', evidence_refs: [{ source_id: 'pack:spinoza-zh' }] },
    ],
  });
  const orphans = detectOrphanClaims({ lessonBody: body });
  // 7 total claims, 2 grounded → 5 orphan
  check('EL6a 5 orphans', orphans.length === 5, `got ${orphans.length}: ${JSON.stringify(orphans)}`);
  check('EL6b canonical_example is orphan', orphans.includes('canonical_example'));
  check('EL6c example_0 + example_1 orphan', orphans.includes('example_0') && orphans.includes('example_1'));
  check('EL6d thesis NOT orphan', !orphans.includes('thesis'));
}

// ─── EL7: aggregateSourceUsage groups by source_id ────────────────────────
{
  const body = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:abc123:7' }] },
      { claim_id: 'mechanism', evidence_refs: [{ source_id: 'book:abc123:7' }] },
      { claim_id: 'misconception_0', evidence_refs: [{ source_id: 'pack:spinoza-zh' }] },
    ],
  });
  const usage = aggregateSourceUsage({ lessonBody: body });
  check('EL7a 2 distinct sources', usage.size === 2);
  check('EL7b book:abc123:7 backs 2 claims', usage.get('book:abc123:7').length === 2);
  check('EL7c book:abc123:7 backs thesis + mechanism', usage.get('book:abc123:7').includes('thesis') && usage.get('book:abc123:7').includes('mechanism'));
  check('EL7d pack backs misconception_0 only', usage.get('pack:spinoza-zh').length === 1 && usage.get('pack:spinoza-zh')[0] === 'misconception_0');
}

// ─── EL8: validateBodyV2 with valid evidence_ledger PASS ──────────────────
{
  const body = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:abc123:7', weight: 0.9, kind: 'direct' }] },
      { claim_id: 'mechanism', evidence_refs: [{ source_id: 'pack:spinoza-zh', weight: 0.7, kind: 'corroborating' }] },
    ],
  });
  // Ensure the body passes other required fields first (the base body has them).
  const errors = lbg.validateBodyV2(body);
  check('EL8a valid evidence_ledger schema passes', errors.length === 0, errors.join(' / '));
}

// ─── EL9: validateBodyV2 with MISSING evidence_ledger PASS (backward-compat) ─
{
  const body = makeBody(); // no evidence_ledger
  const errors = lbg.validateBodyV2(body);
  check('EL9a missing evidence_ledger does not fail schema', errors.length === 0, errors.join(' / '));
}

// ─── EL10: validateBodyV2 with malformed evidence_ledger FAIL gracefully ──
{
  // String instead of array
  const body = makeBody({ evidence_ledger: 'not-an-array' });
  const errors = lbg.validateBodyV2(body);
  check('EL10a string evidence_ledger fails', errors.some(e => /evidence_ledger.*must be array/.test(e)));

  // Array with bad row shape
  const body2 = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'badprefix:xyz', weight: 2.5, kind: 'bogus' }] },
    ],
  });
  const errors2 = lbg.validateBodyV2(body2);
  check('EL10b bad prefix flagged', errors2.some(e => /source_id.*prefix/.test(e)));
  check('EL10c bad weight flagged', errors2.some(e => /weight.*\[0, 1\]/.test(e)));
  check('EL10d bad kind flagged', errors2.some(e => /kind.*must be one of/.test(e)));
}

// ─── EL11: LLM prompt mentions evidence_ledger directive (grep test) ──────
{
  const prompt = lbg._BODY_V2_SYSTEM_PROMPT || '';
  check('EL11a prompt mentions EVIDENCE LEDGER', /EVIDENCE LEDGER/.test(prompt));
  check('EL11b prompt mentions evidence_refs schema', /evidence_refs/.test(prompt));
  check('EL11c prompt mentions kind enum', /direct.*corroborating.*tangential/.test(prompt));
  check('EL11d prompt mentions source_id prefixes', /book:.*pack:.*url:/.test(prompt));
}

// ─── EL12: End-to-end synthetic body 5 claims, 3 grounded → grounding=60% ─
{
  // Minimal body w/ exactly 5 claim ids: thesis + mechanism + canonical_example
  // + misconception_0 + misconception_1. No examples[].
  const body = {
    thesis: 'X causes Y by Z mechanism',
    mechanism_explanation: 'The mechanism is M which produces Y from X.',
    canonical_example: 'Case C illustrates X causing Y at time T.',
    common_misconceptions: ['Wrong-1 — actually right is R1.', 'Wrong-2 — actually right is R2.'],
    exit_proof: 'Apply X→Y to a new case.',
    note_connection: 'Builds on prior X-only treatment.',
    jargon_list: [],
    evidence_cite: [
      { cite_type: 'library', book_id: 'src1', chunk_idx: 1 },
      { cite_type: 'library', book_id: 'src1', chunk_idx: 2 },
      { cite_type: 'community', pack_id: 'p1' },
    ],
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:src1:1', weight: 1, kind: 'direct' }] },
      { claim_id: 'mechanism', evidence_refs: [{ source_id: 'book:src1:2', weight: 1, kind: 'direct' }] },
      { claim_id: 'canonical_example', evidence_refs: [{ source_id: 'pack:p1', weight: 0.8, kind: 'corroborating' }] },
      // misconception_0 + misconception_1 left orphan
    ],
  };
  const ids = enumerateClaimIds(body);
  check('EL12a 5 claim ids enumerated', ids.length === 5, `got ${ids.length}: ${JSON.stringify(ids)}`);
  const g = computeClaimGrounding({ lessonBody: body });
  check('EL12b grounding = 0.6', Math.abs(g - 0.6) < 0.001, `got ${g}`);
  const orphans = detectOrphanClaims({ lessonBody: body });
  check('EL12c 2 orphans (both misconceptions)', orphans.length === 2 && orphans.includes('misconception_0') && orphans.includes('misconception_1'));
  // Also exercise coverage.js roll-up.
  const cov = coverage.computeBodyCoverage(body, { threshold: 60 });
  check('EL12d coverage carries claim_grounding_pct=60', cov.claim_grounding_pct === 60, `got ${cov.claim_grounding_pct}`);
  check('EL12e coverage carries orphan_claims=2', cov.orphan_claims === 2);
  check('EL12f coverage carries ledger_present=true', cov.ledger_present === true);
}

// ─── EL13: collectAvailableSourceIds reads book + pack + url shapes ────────
{
  const body = makeBody({
    evidence_cite: [
      { cite_type: 'library', book_id: 'b1', chunk_idx: 3 },
      { cite_type: 'community', pack_id: 'p1' },
      { cite_type: 'library', book_id: 'b2', chunk_idx: 5, url: 'https://example.com/b2' },
    ],
    sources: [
      { id: 'url:https://manual.example.com', url: 'https://manual.example.com' },
    ],
  });
  const ids = collectAvailableSourceIds(body);
  check('EL13a book:b1:3 present', ids.has('book:b1:3'));
  check('EL13b pack:p1 present', ids.has('pack:p1'));
  check('EL13c book:b2:5 present', ids.has('book:b2:5'));
  check('EL13d url:b2 present (from evidence_cite.url)', ids.has('url:https://example.com/b2'));
  check('EL13e url:manual present (from sources[])', ids.has('url:https://manual.example.com'));
}

// ─── EL14: summarize() returns frozen object with expected fields ──────────
{
  const body = makeBody({
    evidence_ledger: [
      { claim_id: 'thesis', evidence_refs: [{ source_id: 'book:abc123:7' }] },
    ],
  });
  const s = summarize({ lessonBody: body });
  check('EL14a summary frozen', Object.isFrozen(s));
  check('EL14b total_claims=7', s.total_claims === 7);
  check('EL14c grounded_claims=1', s.grounded_claims === 1);
  check('EL14d grounding_pct=14', s.grounding_pct === 14, `got ${s.grounding_pct}`);
  check('EL14e ledger_present=true', s.ledger_present === true);
  check('EL14f legacy body (no ledger) → ledger_present=false', summarize({ lessonBody: makeBody() }).ledger_present === false);
}

// ─── Print + exit ──────────────────────────────────────────────────────────
console.log('\nHYPHA · Evidence Ledger v1.0 smoke (boot-9)');
console.log('-----------------------------------------------');
for (const line of tests) console.log(line);
console.log('-----------------------------------------------');
console.log(`PASSED: ${passed}  FAILED: ${failed}  TOTAL: ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
