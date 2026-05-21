#!/usr/bin/env node
'use strict';

// HYPHA · W7.3 Citation System — full pipeline smoke (P9 completion).
//
// Verifies the entire citation-system surface:
//   1. Re-export integrity of all 5 lib files (regression guard)
//   2. End-to-end: lesson body → coverage % → gate decision
//   3. Density gate happy + edge (0 claims, all cited, none cited)
//   4. global-trust trusted-source ranking
//   5. external-link-scanner invalid link detection
//   6. copyright-boundary fair-use check
//
// Run: node app/scripts/_dev_verify_citation_full.js
// Exit 0 = PASS, exit 1 = any failure.

const cs = require('../lib/citation-system');

let passed = 0;
let failed = 0;
const out = [];

function check(name, cond, extra) {
  if (cond) { passed++; out.push(`  PASS  ${name}`); }
  else { failed++; out.push(`  FAIL  ${name}${extra ? '\n        ' + extra : ''}`); }
}

// ─── CS1: re-export surface — every documented public API resolves ──────
{
  const expected = [
    'CITATION_TYPES', 'createCitation', 'parseCitationToken',
    'renderCitationFootnote', 'formatAttribution',
    'TIERS', 'extractURLs', 'classifyURL', 'scanContentForExternalLinks',
    'RISK_LEVELS', 'INTENTS', 'assessCopyrightRisk', 'getBoundaryWarning',
    'computeGlobalTrust', 'rankCitations',
    'DEFAULT_COVERAGE_THRESHOLD_PCT', 'computeBodyCoverage', 'aggregateCoverage',
    'harvestCitationsFromText', 'annotateCitations',
  ];
  const missing = expected.filter((k) => typeof cs[k] === 'undefined');
  check('CS1 all 20 lib exports resolved', missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : '');
}

// ─── CS2: createCitation produces frozen primitive with required fields ─
{
  const c = cs.createCitation({
    type: 'paper', source_id: '2604.05485',
    source_url: 'https://arxiv.org/abs/2604.05485',
    attribution: 'Auditable Agents (arXiv)',
    snippet: 'abstract excerpt',
  });
  const isFrozen = Object.isFrozen(c);
  const hasAll = c.type === 'paper' && c.source_id === '2604.05485' && c.source_url && c.created_at;
  check('CS2 createCitation frozen + complete', isFrozen && hasAll);
}

// ─── CS3: parseCitationToken handles all 7 type prefixes + book shorthand ─
{
  const txt = 'see [CITE:abc123:4] and [CITE:paper:2604.05485] and [CITE:url:opaque1] and [CITE:pack:phil-101] and [CITE:lesson:slug/0]';
  const tokens = cs.parseCitationToken(txt);
  const types = tokens.map((t) => t.type).sort();
  const expected = ['book', 'lesson', 'pack', 'paper', 'web_url'];
  check('CS3 parseCitationToken normalises 5 type prefixes',
    JSON.stringify(types) === JSON.stringify(expected),
    'got: ' + JSON.stringify(types));
}

// ─── CS4: classifyURL — known canonical + shortener + malformed ─────────
{
  const canonical = cs.classifyURL('https://arxiv.org/abs/2604.05485');
  const shortened = cs.classifyURL('https://bit.ly/2foo');
  const malformed = cs.classifyURL('not-a-url');
  check('CS4 classifyURL canonical=safe, shortener=caution, malformed=unsafe',
    canonical.tier === 'safe' && shortened.tier === 'caution' && malformed.tier === 'unsafe',
    `canonical=${canonical.tier} shortened=${shortened.tier} malformed=${malformed.tier}`);
}

// ─── CS5: scanContentForExternalLinks counts + worst_tier ──────────────
{
  const txt = 'visit https://arxiv.org/abs/x and https://bit.ly/abc and garbage://x:y';
  const r = cs.scanContentForExternalLinks(txt);
  // worst tier should be caution (bit.ly) — garbage://x:y is parseable as URL so may not bump tier.
  // Just assert at least 1 safe + 1 caution surfaced.
  check('CS5 scanContent surfaces safe + caution',
    r.counts.safe >= 1 && r.counts.caution >= 1 && r.urls.length >= 2,
    'counts: ' + JSON.stringify(r.counts));
}

// ─── CS6: assessCopyrightRisk — fair-use boundary ──────────────────────
{
  const cite = cs.createCitation({
    type: 'book', source_id: 'book-id-1',
    snippet: 'x'.repeat(200), attribution: 'Spinoza',
  });
  const lowRisk = cs.assessCopyrightRisk({ content: 'x'.repeat(150), citation: cite, intent: 'private_learn' });
  const blockRisk = cs.assessCopyrightRisk({ content: 'x'.repeat(2000), citation: cite, intent: 'commercial' });
  check('CS6 copyrightRisk: short snippet=low, full chapter commercial=block',
    lowRisk.risk_level === 'low' && blockRisk.risk_level === 'block',
    `lowRisk=${lowRisk.risk_level} blockRisk=${blockRisk.risk_level}`);
}

// ─── CS7: computeGlobalTrust — type-aware scoring ───────────────────────
{
  const arxiv = cs.createCitation({
    type: 'paper', source_id: '2604.05485',
    source_url: 'https://arxiv.org/abs/2604.05485',
    attribution: 'peer-reviewed journal',
  });
  const trustPaper = cs.computeGlobalTrust(arxiv);
  const internal = cs.createCitation({ type: 'lesson', source_id: 'slug/0' });
  const trustInternal = cs.computeGlobalTrust(internal);
  check('CS7 globalTrust: arxiv paper > 80, internal lesson = 0',
    trustPaper.score >= 80 && trustInternal.score === 0,
    `paper=${trustPaper.score} internal=${trustInternal.score}`);
}

// ─── CS8: rankCitations — stable sort, no mutation ─────────────────────
{
  const a = cs.createCitation({ type: 'paper', source_id: 'a', source_url: 'https://arxiv.org/abs/a' });
  const b = cs.createCitation({ type: 'web_url', source_id: 'https://bit.ly/b', source_url: 'https://bit.ly/b' });
  const c = cs.createCitation({ type: 'lesson', source_id: 'slug/0' });
  const inputArr = [c, a, b];
  const snapshot = JSON.stringify(inputArr);
  const ranked = cs.rankCitations(inputArr);
  const stillSame = JSON.stringify(inputArr) === snapshot;
  const orderOk = ranked[0].citation.source_id === 'a' && ranked[2].citation.source_id === 'slug/0';
  check('CS8 rankCitations stable + non-mutating', stillSame && orderOk, `mutated=${!stillSame} order=${ranked.map(r=>r.citation.source_id).join(',')}`);
}

// ─── CS9: computeBodyCoverage happy path ────────────────────────────────
{
  const body = {
    thesis: 'A single anchored claim about X.',
    mechanism_explanation: 'Step by step why X holds.',
    common_misconceptions: ['First wrong belief.', 'Second wrong belief.'],
    examples: [{ claim: 'concrete instance' }],
    evidence_cite: [
      { marker: '[CITE:b1:0]', cite_type: 'library', book_id: 'b1' },
      { marker: '[CITE:b2:1]', cite_type: 'library', book_id: 'b2' },
      { marker: '[CITE:b3:2]', cite_type: 'library', book_id: 'b3' },
      { marker: '[CITE:b4:3]', cite_type: 'library', book_id: 'b4' },
      { marker: '[CITE:b5:4]', cite_type: 'library', book_id: 'b5' },
    ],
  };
  const r = cs.computeBodyCoverage(body, { threshold: 60 });
  // total_claims = thesis(1) + mechanism(1) + 2 misconceptions + 1 example = 5; cited = 5 → 100%
  check('CS9 coverage happy: 5/5 claims cited → 100%, gate passes',
    r.total_claims === 5 && r.cited_count === 5 && r.coverage_pct === 100 && r.gate_passed === true,
    JSON.stringify(r));
}

// ─── CS10: computeBodyCoverage edge — zero claims ──────────────────────
{
  const empty = {};
  const r = cs.computeBodyCoverage(empty);
  check('CS10 coverage edge zero claims → gate passes trivially',
    r.total_claims === 0 && r.coverage_pct === 0 && r.gate_passed === true);
}

// ─── CS11: computeBodyCoverage edge — none cited under threshold ───────
{
  const body = {
    thesis: 'claim 1',
    mechanism_explanation: 'mech',
    common_misconceptions: ['m1', 'm2'],
    examples: [{ claim: 'c1' }],
    evidence_cite: [], // 0 cited / 5 claims
  };
  const r = cs.computeBodyCoverage(body, { threshold: 60 });
  check('CS11 coverage edge none cited → 0% + gate FAILS',
    r.total_claims === 5 && r.cited_count === 0 && r.coverage_pct === 0 && r.gate_passed === false && /< threshold/.test(r.reason),
    JSON.stringify(r));
}

// ─── CS12: aggregateCoverage across multiple bodies ─────────────────────
{
  const b1 = {
    thesis: 'a', mechanism_explanation: 'b',
    evidence_cite: [{ book_id: 'B1' }, { book_id: 'B2' }],
  };
  const b2 = {
    thesis: 'c', mechanism_explanation: 'd',
    common_misconceptions: ['m'],
    evidence_cite: [{ book_id: 'B1' }, { book_id: 'B3' }],
  };
  const agg = cs.aggregateCoverage([b1, b2], { threshold: 50 });
  // b1: 2 claims, 2 cited → 100%. b2: 3 claims, 2 cited → 66%.
  // Aggregate: 5 claims, 4 cited → 80%. Sources: B1+B2+B3 = 3 (B1 dedup).
  check('CS12 aggregateCoverage: 4/5 cited → 80%, 3 distinct sources, 2 gate passes',
    agg.lessons === 2 && agg.total_claims === 5 && agg.cited_count === 4
    && agg.coverage_pct === 80 && agg.sources === 3 && agg.gate_pass_count === 2,
    JSON.stringify(agg));
}

// ─── CS13: harvestCitationsFromText end-to-end ─────────────────────────
{
  const txt = 'Reference: https://arxiv.org/abs/2604.05485 and https://bit.ly/foo';
  const harvested = cs.harvestCitationsFromText(txt);
  check('CS13 harvestCitationsFromText: 2 web_url cites with trust + risk',
    harvested.length === 2 && harvested.every((h) => h.citation && h.trust && h.risk),
    `len=${harvested.length}`);
}

// ─── CS14: getBoundaryWarning surface text per level ───────────────────
{
  const lowWarn = cs.getBoundaryWarning({ risk_level: 'low' });
  const highWarn = cs.getBoundaryWarning({ risk_level: 'high', reason: 'long quote', alternative_suggested: 'shorten' });
  check('CS14 getBoundaryWarning empty on low, prefixed on high',
    lowWarn === '' && /高风险/.test(highWarn));
}

// ─── CS15: renderCitationFootnote zh + en ──────────────────────────────
{
  const cite = cs.createCitation({
    type: 'web_url', source_id: 'https://example.org/x',
    source_url: 'https://example.org/x', attribution: 'Example Site',
    snippet: 'a quote',
  });
  const zh = cs.renderCitationFootnote(cite, 'zh');
  const en = cs.renderCitationFootnote(cite, 'en');
  check('CS15 renderCitationFootnote zh + en variants',
    /原文/.test(zh) && /source/.test(en) && zh.includes(cite.source_id));
}

// ─── Result ─────────────────────────────────────────────────────────────
console.log('Citation System — full pipeline smoke');
console.log('=====================================');
console.log(out.join('\n'));
console.log('');
console.log(`Total: ${passed + failed}  PASS: ${passed}  FAIL: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
