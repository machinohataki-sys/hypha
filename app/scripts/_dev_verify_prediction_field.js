#!/usr/bin/env node
'use strict';

// HYPHA · Decision Log + Assumption Ledger — prediction field smoke.
//
// Per Scout S63 (Agentic Harness Engineering, arXiv 2604.25850) + S67
// (Anthropic April-23 silent-regression postmortem) + S73 (ReDAct uncertainty-
// deferral, arXiv 2604.07036) 2026-05-14 digest: every Decision / Assumption
// row carries an optional falsifiable `prediction:{claim, falsifier, deadline_iso}`
// contract. Kill Watcher nightly scans for past-deadline entries + emits a
// non-mutating REVIEW event to `vault/.hypha/kill-watcher.jsonl` suggesting a
// lifecycle transition for UI/user to action.
//
// Tests (14):
//   PF1  Decision Log: prediction round-trips on append + list
//   PF2  Assumption Ledger: prediction round-trips on append + list
//   PF3  Vague falsifier "we'll see" → silent-strip (3 vague rejected)
//   PF4  Concrete falsifier with number / % / date → kept (3 concrete accepted)
//   PF5  Backward compatibility: legacy row without prediction still loads
//   PF6  Kill Watcher detects past-deadline assumption → REVIEW event written
//   PF7  Kill Watcher detects past-deadline decision   → REVIEW event written
//   PF8  Kill Watcher de-dupes: 2nd sweep does NOT re-emit same REVIEW
//   PF9  REVIEW event jsonl shape: {ts, entry_id, kind, slug, suggested_transition, ...}
//   PF10 Kill Watcher leaves source entry UNMUTATED beyond existing auto-refute
//        (we verify by checking listAssumptions returns the original claim text)
//   PF11 suggested_transition mapping: assumption unvalidated → 'active→invalidated'
//   PF12 suggested_transition mapping: assumption validated → 'active→ratified'
//   PF13 suggested_transition mapping: decision → 'review_needed'
//   PF14 Future deadline → NO REVIEW event emitted (boundary)
//
// Run: node app/scripts/_dev_verify_prediction_field.js
// Exit 0 = PASS, 1 = any failure.

const fs = require('node:fs');
const path = require('node:path');

const vault = require('../lib/vault');
const decisionLog = require('../lib/creation/decision-log');
const assumptionLedger = require('../lib/creation/assumption-ledger');
const killWatcher = require('../lib/creation/kill-watcher');

const SLUG = '__verify_prediction_field__';

const tests = [];
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  PASS  ${name}`); }
  else { failed++; tests.push(`  FAIL  ${name}${extra ? '\n        ' + extra : ''}`); }
}

function vaultDir() { return path.join(vault.resolveRoot(), SLUG); }

function cleanSlug() {
  const dir = vaultDir();
  if (!fs.existsSync(dir)) return;
  for (const f of ['decisions.jsonl', 'assumptions.jsonl', 'sparks.jsonl', 'decision-reviews.jsonl']) {
    const abs = path.join(dir, f);
    if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (_) {} }
  }
}

function cleanReviewAudit() {
  const abs = path.join(vault.resolveRoot(), '.hypha', 'kill-watcher.jsonl');
  if (fs.existsSync(abs)) { try { fs.unlinkSync(abs); } catch (_) {} }
}

// Silence the console.warn the libraries emit on dropped predictions.
function withSilentWarn(fn) {
  const orig = console.warn;
  const captured = [];
  console.warn = (...args) => { captured.push(args.join(' ')); };
  try { return { result: fn(), warns: captured }; }
  finally { console.warn = orig; }
}

function dateOffset(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ─── Setup ─────────────────────────────────────────────────────────────────
cleanSlug();
cleanReviewAudit();

// ─── PF1: Decision Log prediction round-trip ───────────────────────────────
{
  const append = decisionLog.appendDecision(SLUG, {
    lesson_idx: 0,
    decision: 'PF1 decision with prediction ≥10 chars',
    prediction: {
      claim: 'lesson plan critique-loop ship hits 80% acceptance',
      falsifier: 'if acceptance < 80% by 2026-06-01 then revert',
      deadline_iso: dateOffset(30),
    },
  });
  check('PF1a appendDecision ok', append && append.ok === true);
  check('PF1b prediction.claim persisted',
    append.row && append.row.prediction && typeof append.row.prediction.claim === 'string');
  const list = decisionLog.listDecisions(SLUG);
  const hit = list.find(r => r.decision.startsWith('PF1 decision'));
  check('PF1c list round-trip prediction', hit && hit.prediction && hit.prediction.falsifier.includes('80%'));
}

// ─── PF2: Assumption Ledger prediction round-trip ─────────────────────────
{
  const append = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 0,
    claim: 'PF2 assumption with prediction ≥10 chars',
    state: 'unvalidated',
    prediction: {
      claim: 'unit-test coverage will exceed 80% by week 4',
      falsifier: 'coverage < 80% on 2026-06-15 → invalidated',
      deadline_iso: dateOffset(30),
    },
  });
  check('PF2a appendAssumption ok', append && append.ok === true);
  check('PF2b prediction persisted',
    append.row && append.row.prediction && append.row.prediction.deadline_iso === dateOffset(30));
  const list = assumptionLedger.listAssumptions(SLUG);
  const hit = list.find(r => r.claim.startsWith('PF2 assumption'));
  check('PF2c list round-trip prediction', hit && hit.prediction && /coverage/.test(hit.prediction.claim));
}

// ─── PF3: Vague falsifier silent-strip ─────────────────────────────────────
// intentional-placeholder: the strings "TBD" / "we'll see" / "probably" below are
// TEST FIXTURES, not real work-in-progress markers — they are the exact tokens the
// vague-falsifier guard MUST reject (see VAGUE_FALSIFIER_RE in decision-log.js).
{
  const vagueCases = [
    { name: "we'll see", falsifier: "we'll see how things go in the future" },
    { name: 'tbd-token', falsifier: 'TBD honestly, depends on the team' },
    { name: 'probably',  falsifier: 'probably we will find out one way or another' },
  ];
  for (const c of vagueCases) {
    const { result } = withSilentWarn(() => decisionLog.appendDecision(SLUG, {
      lesson_idx: 0,
      decision: `PF3 vague-${c.name} decision ≥10 chars`,
      prediction: {
        claim: 'this is a perfectly long claim string for validation',
        falsifier: c.falsifier,
        deadline_iso: dateOffset(30),
      },
    }));
    check(`PF3 vague "${c.name}" → row writes`, result && result.ok === true);
    check(`PF3 vague "${c.name}" → prediction STRIPPED`,
      result && result.row && result.row.prediction === undefined,
      `got row.prediction=${JSON.stringify(result && result.row && result.row.prediction)}`);
  }
}

// ─── PF4: Concrete falsifier kept ──────────────────────────────────────────
{
  const concreteCases = [
    { name: 'percent',   falsifier: 'if conversion < 5% by week 4 then revert' },
    { name: 'iso-date',  falsifier: 'no traction by 2026-07-01 means kill it' },
    { name: 'numeric',   falsifier: 'fewer than 100 active users at deadline' },
  ];
  for (const c of concreteCases) {
    const append = decisionLog.appendDecision(SLUG, {
      lesson_idx: 0,
      decision: `PF4 concrete-${c.name} decision ≥10 chars`,
      prediction: {
        claim: 'this is a perfectly long claim string for validation',
        falsifier: c.falsifier,
        deadline_iso: dateOffset(30),
      },
    });
    check(`PF4 concrete "${c.name}" → row writes`, append && append.ok === true);
    check(`PF4 concrete "${c.name}" → prediction KEPT`,
      append.row && append.row.prediction && append.row.prediction.falsifier === c.falsifier);
  }
}

// ─── PF5: Backward compatibility — legacy row without prediction ──────────
{
  const append = decisionLog.appendDecision(SLUG, {
    lesson_idx: 0,
    decision: 'PF5 legacy decision without prediction field, ≥10 chars',
  });
  check('PF5a legacy row writes', append && append.ok === true);
  check('PF5b legacy row has no prediction',
    append.row && append.row.prediction === undefined);
  const list = decisionLog.listDecisions(SLUG);
  const hit = list.find(r => r.decision.startsWith('PF5'));
  check('PF5c legacy row round-trips', hit && hit.prediction === undefined);
}

// ─── PF6 + PF11: Kill Watcher past-deadline assumption → REVIEW ───────────
{
  const yesterday = dateOffset(-1);
  const append = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 0,
    claim: 'PF6 past-deadline assumption with prediction ≥10 chars',
    state: 'unvalidated',
    prediction: {
      claim: 'demand validation will yield 10 paying users',
      falsifier: 'fewer than 10 paying users by deadline',
      deadline_iso: yesterday,
    },
  });
  check('PF6a inject past-deadline assumption ok', append && append.ok === true);
  const id = append.row.assumption_id;

  // Run the sweep + sniff the audit log.
  (async () => {
    const sweep = await killWatcher.runKillWatcherSweep({ vaultRoot: vault.resolveRoot() });
    check('PF6b sweep returns ok', sweep && sweep.ok === true);
    check('PF6c summary reviews_emitted is array',
      Array.isArray(sweep.summary.by_kind.reviews_emitted));

    const reviews = killWatcher.loadReviewEvents();
    const hit = reviews.find(r => r.entry_id === id);
    check('PF6d REVIEW event emitted for our assumption', !!hit, `reviews=${JSON.stringify(reviews)}`);
    check('PF6e REVIEW event kind=assumption', hit && hit.kind === 'assumption');
    check('PF6f REVIEW event includes falsifier', hit && hit.falsifier && hit.falsifier.length > 0);
    check('PF6g REVIEW event includes deadline_iso', hit && hit.deadline_iso === yesterday);
    // PF11: unvalidated + deadline passed → 'active→invalidated'
    check('PF11 suggested_transition active→invalidated for unvalidated',
      hit && hit.suggested_transition === 'active→invalidated',
      `got: ${hit && hit.suggested_transition}`);

    // ─── PF10: source entry not mutated beyond existing auto-refute ─────
    // The existing auto-refute appends a new row but the original claim text
    // must still be the same (latest row carries final state).
    const listAfter = assumptionLedger.listAssumptions(SLUG).filter(r => r.assumption_id === id);
    check('PF10a assumption still findable after sweep', listAfter.length === 1);
    check('PF10b claim text unchanged',
      listAfter[0].claim === 'PF6 past-deadline assumption with prediction ≥10 chars');

    // ─── PF8: 2nd sweep does NOT re-emit same REVIEW ────────────────────
    const beforeLen = reviews.length;
    const sweep2 = await killWatcher.runKillWatcherSweep({ vaultRoot: vault.resolveRoot() });
    check('PF8a 2nd sweep ok', sweep2 && sweep2.ok === true);
    const reviews2 = killWatcher.loadReviewEvents();
    const duplicates = reviews2.filter(r => r.entry_id === id);
    check('PF8b de-dup: still exactly 1 REVIEW for this id',
      duplicates.length === 1,
      `got ${duplicates.length}, reviews2.length before/after = ${beforeLen}/${reviews2.length}`);

    // ─── PF7 + PF13: decision past-deadline → REVIEW event ──────────────
    const decAppend = decisionLog.appendDecision(SLUG, {
      lesson_idx: 0,
      decision: 'PF7 past-deadline decision ≥10 chars',
      prediction: {
        claim: 'shipping latency stays below 500ms p99',
        falsifier: 'p99 > 500ms by week 2 means rollback',
        deadline_iso: yesterday,
      },
    });
    check('PF7a inject past-deadline decision ok', decAppend && decAppend.ok === true);
    const decTs = decAppend.row.ts;

    const sweep3 = await killWatcher.runKillWatcherSweep({ vaultRoot: vault.resolveRoot() });
    check('PF7b 3rd sweep ok', sweep3 && sweep3.ok === true);
    const reviews3 = killWatcher.loadReviewEvents();
    const decHit = reviews3.find(r => r.kind === 'decision' && r.entry_id === decTs);
    check('PF7c decision REVIEW event emitted', !!decHit);
    check('PF13 decision suggested_transition = review_needed',
      decHit && decHit.suggested_transition === 'review_needed',
      `got: ${decHit && decHit.suggested_transition}`);

    // ─── PF9: REVIEW event shape audit ──────────────────────────────────
    if (decHit) {
      check('PF9a has ts (ISO)', typeof decHit.ts === 'string' && !Number.isNaN(Date.parse(decHit.ts)));
      check('PF9b has entry_id', typeof decHit.entry_id === 'string');
      check('PF9c has kind', ['assumption', 'decision', 'spark'].includes(decHit.kind));
      check('PF9d has slug', decHit.slug === SLUG);
      check('PF9e has suggested_transition',
        ['active→invalidated', 'active→ratified', 'review_needed'].includes(decHit.suggested_transition));
      check('PF9f has falsifier', typeof decHit.falsifier === 'string' && decHit.falsifier.length > 0);
      check('PF9g has deadline_iso', typeof decHit.deadline_iso === 'string');
    } else {
      check('PF9 shape audit', false, 'no decision REVIEW event to inspect');
    }

    // ─── PF12: validated assumption past deadline → 'active→ratified' ───
    const validAppend = assumptionLedger.appendAssumption(SLUG, {
      lesson_idx: 0,
      claim: 'PF12 validated assumption past deadline ≥10 chars',
      state: 'unvalidated',
      prediction: {
        claim: 'beta cohort reports 90% satisfaction',
        falsifier: 'satisfaction < 90% by 2026-05-01 means refute',
        deadline_iso: yesterday,
      },
    });
    check('PF12a inject ok', validAppend && validAppend.ok === true);
    const validId = validAppend.row.assumption_id;
    // Transition unvalidated → validated BEFORE the sweep so kill-watcher sees 'validated'.
    const trans1 = assumptionLedger.updateAssumptionState(SLUG, validId, 'validated');
    check('PF12b transition unvalidated→validated ok', trans1 && trans1.ok === true);

    cleanReviewAudit(); // start clean for the validated-state check
    const sweep4 = await killWatcher.runKillWatcherSweep({ vaultRoot: vault.resolveRoot() });
    check('PF12c sweep ok', sweep4 && sweep4.ok === true);
    const reviews4 = killWatcher.loadReviewEvents();
    const validHit = reviews4.find(r => r.entry_id === validId);
    check('PF12d REVIEW emitted for validated assumption', !!validHit);
    check('PF12e suggested_transition = active→ratified',
      validHit && validHit.suggested_transition === 'active→ratified',
      `got: ${validHit && validHit.suggested_transition}`);

    // ─── PF14: future deadline → NO REVIEW emission ─────────────────────
    cleanReviewAudit();
    const futureAppend = assumptionLedger.appendAssumption(SLUG, {
      lesson_idx: 0,
      claim: 'PF14 future-deadline assumption ≥10 chars',
      state: 'unvalidated',
      prediction: {
        claim: 'we will see 100+ signups',
        falsifier: 'fewer than 100 signups by week 8',
        deadline_iso: dateOffset(60),
      },
    });
    check('PF14a inject future ok', futureAppend && futureAppend.ok === true);
    const futureId = futureAppend.row.assumption_id;
    const sweep5 = await killWatcher.runKillWatcherSweep({ vaultRoot: vault.resolveRoot() });
    check('PF14b sweep ok', sweep5 && sweep5.ok === true);
    const reviews5 = killWatcher.loadReviewEvents();
    const futureHit = reviews5.find(r => r.entry_id === futureId);
    check('PF14c NO REVIEW emitted for future deadline', !futureHit);

    // ─── Done ───────────────────────────────────────────────────────────
    console.log('\nHYPHA · prediction-field smoke');
    console.log('-----------------------------------------------');
    for (const line of tests) console.log(line);
    console.log('-----------------------------------------------');
    console.log(`PASSED: ${passed}  FAILED: ${failed}  TOTAL: ${passed + failed}`);
    process.exit(failed === 0 ? 0 : 1);
  })().catch(err => {
    console.error('[verify] uncaught: ' + (err && err.stack ? err.stack : err));
    process.exit(2);
  });
}
