#!/usr/bin/env node
'use strict';

// HYPHA · Phase C · _dev_verify_lifetime_ipc (2026-05-17, Agent C / Glue)
//
// Module smoke for `app/lib/lifetime-ledger/index.js`. We do NOT boot Electron
// or write to the real vault — we shim vault via Node's require.cache before
// the ledger module loads, then drive appendEntry/getLedger through the shim.
//
// Validates:
//   1. module.exports surfaces 4 key fns: getLedger / appendEntry /
//      aggregateByLink / LEDGER_REL.
//   2. LEDGER_REL('foo') === 'foo/lifetime-ledger.jsonl' (path contract).
//   3. With a mock vault, appendEntry → getLedger roundtrip increases
//      entries.length by 1 and latestWeek updates.
//   4. aggregateByLink sums axis_counts across entries scoped to a linkIdx.
//   5. getLedger on empty slug returns the documented empty shape.
//
// Run:  node app/scripts/_dev_verify_lifetime_ipc.js
// Exit: 0 = PASS N/N, 1 = any FAIL.

const path = require('path');
const Module = require('module');

const results = [];
function record(name, ok, msg) {
  results.push({ name, ok, msg });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${msg ? '  ' + msg : ''}`);
}

// ─── Build an in-memory vault shim ─────────────────────────────────────
// The lifetime-ledger module asks for vault.appendJSONL + vault.readJSONL
// (preferred) with a vault.read + vault.write fallback. We supply only the
// preferred two — that's the path agent A's IPC actually runs.
const memFiles = new Map();
const vaultShim = {
  appendJSONL: (rel, obj) => {
    const prev = memFiles.get(rel) || '';
    memFiles.set(rel, prev + JSON.stringify(obj) + '\n');
  },
  readJSONL: (rel) => {
    const blob = memFiles.get(rel) || '';
    return blob.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  },
};

// Inject vault shim into the require cache so the next require() of
// '../vault' from inside lifetime-ledger resolves to vaultShim.
const vaultAbs = path.resolve(__dirname, '..', 'lib', 'vault.js');
// Match Node's filename normalization (Windows backslashes etc.)
const vaultAbsNormalized = path.normalize(vaultAbs);
require.cache[vaultAbsNormalized] = {
  id: vaultAbsNormalized,
  filename: vaultAbsNormalized,
  loaded: true,
  exports: vaultShim,
};

// ─── Test 1: module loads + 4 key fns exported ─────────────────────────
let ledger;
try {
  ledger = require('../lib/lifetime-ledger');
  record('lifetime-ledger module loads', !!ledger, '(via require with vault shimmed)');
} catch (e) {
  record('lifetime-ledger module loads', false, e.message);
  process.exit(1);
}
for (const fn of ['getLedger', 'appendEntry', 'aggregateByLink', 'LEDGER_REL']) {
  record(
    `exports.${fn} is a function`,
    typeof ledger[fn] === 'function',
    `typeof=${typeof ledger[fn]}`,
  );
}

// ─── Test 2: LEDGER_REL path contract ──────────────────────────────────
record(
  "LEDGER_REL('foo') === 'foo/lifetime-ledger.jsonl'",
  ledger.LEDGER_REL('foo') === 'foo/lifetime-ledger.jsonl',
  `got=${ledger.LEDGER_REL('foo')}`,
);
record(
  "LEDGER_REL('slug-with-dash') applies same pattern",
  ledger.LEDGER_REL('slug-with-dash') === 'slug-with-dash/lifetime-ledger.jsonl',
  `got=${ledger.LEDGER_REL('slug-with-dash')}`,
);

// ─── Test 3: empty-slug shape ──────────────────────────────────────────
(async () => {
  const empty = await ledger.getLedger('does-not-exist-slug');
  record(
    'getLedger(missing) returns documented empty shape',
    empty && Array.isArray(empty.entries) && empty.entries.length === 0
      && empty.firstWeek === null && empty.latestWeek === null,
    `got=${JSON.stringify(empty)}`,
  );

  // ─── Test 4: appendEntry → getLedger roundtrip ───────────────────────
  const slug = 'smoke-slug';
  const before = await ledger.getLedger(slug);
  const beforeLen = before.entries.length;

  const writeRes = await ledger.appendEntry(slug, {
    weekIso: '2026-W20',
    linkIdx: 0,
    axis_counts: { learn: 3, practice: 12, produce: 1, read: 4, reflect: 2 },
    note: 'first honest week',
  });
  record(
    'appendEntry returns { ok: true, entry }',
    writeRes && writeRes.ok === true && writeRes.entry && writeRes.entry.weekIso === '2026-W20',
    `result=${JSON.stringify(writeRes && { ok: writeRes.ok, week: writeRes.entry && writeRes.entry.weekIso })}`,
  );

  const after = await ledger.getLedger(slug);
  record(
    'getLedger.entries.length increased by 1',
    after.entries.length === beforeLen + 1,
    `before=${beforeLen} after=${after.entries.length}`,
  );
  record(
    'latestWeek === appended weekIso',
    after.latestWeek === '2026-W20',
    `latestWeek=${after.latestWeek}`,
  );
  record(
    'firstWeek populated after first write',
    after.firstWeek === '2026-W20',
    `firstWeek=${after.firstWeek}`,
  );

  // ─── Test 5: aggregateByLink sums axis_counts ─────────────────────────
  await ledger.appendEntry(slug, {
    weekIso: '2026-W21',
    linkIdx: 0,
    axis_counts: { learn: 2, practice: 18, produce: 3, read: 5, reflect: 1 },
    note: 'second week — practice surged',
  });
  // Different linkIdx — must NOT roll into the link-0 aggregate.
  await ledger.appendEntry(slug, {
    weekIso: '2026-W21',
    linkIdx: 1,
    axis_counts: { learn: 99, practice: 99, produce: 99, read: 99, reflect: 99 },
    note: 'should be isolated from link 0 aggregate',
  });
  const agg = await ledger.aggregateByLink(slug, 0);
  const expected = { learn: 5, practice: 30, produce: 4, read: 9, reflect: 3 };
  let aggOK = true;
  for (const [axis, n] of Object.entries(expected)) {
    if (agg[axis] !== n) { aggOK = false; break; }
  }
  record(
    'aggregateByLink(slug, 0) sums only link-0 entries',
    aggOK,
    `got=${JSON.stringify(agg)}  expected=${JSON.stringify(expected)}`,
  );
  record(
    'aggregateByLink(slug, 0) excludes link-1 noise',
    agg.learn === 5 && agg.practice === 30,
    '(link-1 entry with 99s did not contaminate link-0)',
  );

  // ─── Test 6: sanitizer rejects truly invalid counts ──────────────────
  // The contract (per _sanitizeCounts in app/lib/lifetime-ledger/index.js):
  //   - drops non-finite (NaN, 'oops' → NaN), negative, and non-string keys
  //   - KEEPS 0 — zero hours is a legitimate honest report, and Number(null)
  //     coerces to 0 so `null` survives as 0 (matches "no work this week")
  const dirtyWrite = await ledger.appendEntry(slug, {
    weekIso: '2026-W22',
    linkIdx: 0,
    axis_counts: { learn: 'oops', practice: -3, produce: NaN, read: 7, reflect: null },
    note: 'mixed-quality input',
  });
  const sanitized = dirtyWrite.entry && dirtyWrite.entry.axis_counts;
  record(
    'appendEntry sanitizes: drops NaN-coerced / negative',
    dirtyWrite.ok && sanitized
      && !('learn' in sanitized)    // 'oops' → NaN → dropped
      && !('practice' in sanitized) // -3 → dropped
      && !('produce' in sanitized)  // NaN → dropped
      && sanitized.read === 7,      // valid → kept
    `sanitized=${JSON.stringify(sanitized)}`,
  );
  record(
    'appendEntry preserves zero (honest "no work this week")',
    sanitized && sanitized.reflect === 0, // Number(null) === 0, valid count
    '(0 is a legitimate honest count — must not be dropped)',
  );

  // ─── Summary ─────────────────────────────────────────────────────────
  const passN = results.filter(r => r.ok).length;
  const failN = results.length - passN;
  console.log('');
  console.log(`PASS ${passN}/${results.length}` + (failN > 0 ? `  (${failN} FAIL)` : ''));
  process.exit(failN > 0 ? 1 : 0);
})().catch((e) => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
