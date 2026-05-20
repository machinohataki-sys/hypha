'use strict';

// HYPHA · Phase C · lifetime-ledger storage smoke (2026-05-17).
//
// Stubs vault.appendJSONL + vault.readJSONL with an in-memory map, then
// drives appendEntry → aggregateByLink → _isoWeek to verify:
//   1. appendEntry writes axis_counts cumulatively to the right key
//   2. aggregateByLink correctly sums across multiple entries per link
//   3. linkIdx filter isolates entries
//   4. _isoWeek emits "YYYY-Www" zero-padded format
//
// Standalone Node. No Electron required. Stubs the vault module BEFORE the
// ledger module is required so the in-memory shim is used end-to-end.
//
// Exit: 0 PASS / 1 FAIL.

const path = require('node:path');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// Inject in-memory vault stub. Must run BEFORE requiring the ledger module.
// We monkeypatch Module._resolveFilename + require.cache to point any
// `require('../vault')` (from app/lib/lifetime-ledger/index.js) at our shim.
// ---------------------------------------------------------------------------

const fakeStore = new Map();   // rel -> array of {entry...}
const vaultShim = {
  appendJSONL(rel, entry) {
    const arr = fakeStore.get(rel) || [];
    arr.push(entry);
    fakeStore.set(rel, arr);
  },
  readJSONL(rel) {
    return (fakeStore.get(rel) || []).slice();
  },
  readJSON(_rel) { return null; },
  read(rel) {
    const arr = fakeStore.get(rel);
    if (!arr) return null;
    return { body: arr.map(JSON.stringify).join('\n') + '\n' };
  },
  write(rel, body) {
    const arr = String(body).split('\n').filter(Boolean).map(l => JSON.parse(l));
    fakeStore.set(rel, arr);
  },
};

// Pre-populate require cache so when lifetime-ledger/index.js calls
// `require('../vault')`, it gets our shim. The resolved path uses Node's
// native resolution against the actual file location.
const vaultRealPath = require.resolve(path.join(__dirname, '..', 'lib', 'vault.js'));
require.cache[vaultRealPath] = {
  id: vaultRealPath,
  filename: vaultRealPath,
  loaded: true,
  exports: vaultShim,
};

const ledger = require(path.join(__dirname, '..', 'lib', 'lifetime-ledger'));

// ---------------------------------------------------------------------------
// Colour output.
// ---------------------------------------------------------------------------

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(G('  PASS'), name, detail ? `· ${detail}` : '');
  } else {
    fail += 1;
    console.log(R('  FAIL'), name, detail ? `· ${detail}` : '');
  }
}

// ---------------------------------------------------------------------------
// Test cases.
// ---------------------------------------------------------------------------

(async () => {
  console.log(Y('lifetime-ledger smoke'));
  console.log('────────────────────────────────────────');

  // ---- 1. appendEntry x 3 -------------------------------------------------
  const slug = '__verify_lifetime_ledger__';
  const r1 = await ledger.appendEntry(slug, {
    linkIdx: 0,
    axis_counts: { learn: 4, practice: 12 },
    weekIso: '2026-W20',
    note: 'week 1',
  });
  check('appendEntry #1 ok', r1.ok === true, JSON.stringify(r1));

  const r2 = await ledger.appendEntry(slug, {
    linkIdx: 0,
    axis_counts: { learn: 3, practice: 10, read: 2 },
    weekIso: '2026-W21',
  });
  check('appendEntry #2 ok', r2.ok === true);

  const r3 = await ledger.appendEntry(slug, {
    linkIdx: 1,            // different link — should NOT contribute to link 0
    axis_counts: { learn: 99, practice: 99 },
    weekIso: '2026-W21',
  });
  check('appendEntry #3 ok', r3.ok === true);

  // ---- 2. getLedger surfaces entries --------------------------------------
  const { entries, firstWeek, latestWeek } = await ledger.getLedger(slug);
  check('getLedger entries length', entries.length === 3, `got ${entries.length}`);
  check('getLedger firstWeek', firstWeek === '2026-W20', `got ${firstWeek}`);
  check('getLedger latestWeek', latestWeek === '2026-W21', `got ${latestWeek}`);

  // ---- 3. aggregateByLink — link 0 ---------------------------------------
  const a0 = await ledger.aggregateByLink(slug, 0);
  check('aggregate link 0 learn=7',    a0.learn === 7,    `got ${a0.learn}`);
  check('aggregate link 0 practice=22', a0.practice === 22, `got ${a0.practice}`);
  check('aggregate link 0 read=2',     a0.read === 2,     `got ${a0.read}`);
  check('aggregate link 0 ! leak link1', a0.learn !== 7 + 99, `got ${a0.learn}`);

  // ---- 4. aggregateByLink — link 1 isolation ------------------------------
  const a1 = await ledger.aggregateByLink(slug, 1);
  check('aggregate link 1 learn=99',    a1.learn === 99,    `got ${a1.learn}`);
  check('aggregate link 1 practice=99', a1.practice === 99, `got ${a1.practice}`);

  // ---- 5. _isoWeek format -------------------------------------------------
  const iso = ledger._isoWeek(new Date(Date.UTC(2026, 4, 14))); // 2026-05-14 = Thursday W20
  check('_isoWeek shape YYYY-Www', /^\d{4}-W\d{2}$/.test(iso), `got "${iso}"`);
  const iso2 = ledger._isoWeek(new Date(Date.UTC(2026, 0, 5))); // 2026-01-05 = W02
  check('_isoWeek zero-pad week', iso2 === '2026-W02', `got "${iso2}"`);

  // ---- 6. defensive bad input --------------------------------------------
  const bad1 = await ledger.appendEntry(null, { linkIdx: 0 });
  check('appendEntry rejects null slug', bad1.ok === false, JSON.stringify(bad1));
  const bad2 = await ledger.getLedger('');
  check('getLedger empty slug returns empty', bad2.entries.length === 0);
  const bad3 = await ledger.appendEntry('foo', { linkIdx: 0, axis_counts: { x: -5, y: 'nope', z: 3 } });
  check('appendEntry sanitizes negative/non-numeric', bad3.ok === true && bad3.entry.axis_counts.x === undefined && bad3.entry.axis_counts.y === undefined && bad3.entry.axis_counts.z === 3, JSON.stringify(bad3.entry && bad3.entry.axis_counts));

  // ---- summary ------------------------------------------------------------
  console.log('────────────────────────────────────────');
  const total = pass + fail;
  if (fail === 0) {
    console.log(G(`PASS ${pass}/${total}`));
    process.exit(0);
  } else {
    console.log(R(`FAIL ${fail}/${total}`));
    process.exit(1);
  }
})().catch((err) => {
  console.error(R('uncaught:'), err && err.stack || err);
  process.exit(2);
});
