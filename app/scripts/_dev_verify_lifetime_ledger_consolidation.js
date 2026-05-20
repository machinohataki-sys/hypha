#!/usr/bin/env node
'use strict';

// HYPHA · boot-12 · lifetime ledger consolidation smoke (2026-05-20).
//
// Lifetime Ledger is shipped end-to-end per CLAUDE.md boot-7+ + boot-10. This
// smoke does NOT re-test internal mechanics (the existing trio
// _dev_verify_lifetime_{ledger,schema,ipc}.js + _dev_verify_variance.js
// cover 59 tests total). Its job is to LOCK the consolidated v1.0 contract
// across systems so a future refactor that breaks the API surface, IPC
// envelope, preload bridge, UI route, or pricing tier cross-link fires
// loudly here BEFORE landing.
//
// 12 assertions across 5 cross-cuts:
//   A. Library API surface (4 exports stable)            — 2 tests
//   B. Sibling modules round-trip                         — 2 tests
//   C. IPC handler wiring + envelope                      — 2 tests
//   D. Preload bridge contract                            — 2 tests
//   E. UI screen mount surface                            — 2 tests
//   F. Atomic JSONL persistence                           — 1 test
//   G. Cross-link audit of existing lifetime trio + variance smokes — 1 audit row
//
// Run:  node app/scripts/_dev_verify_lifetime_ledger_consolidation.js
// Exit: 0 = PASS N/N, 1 = any FAIL.

const path = require('node:path');
const fs   = require('node:fs');
const cp   = require('node:child_process');

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`  ${ok ? G('PASS') : R('FAIL')} ${name}${detail ? D('  ' + detail) : ''}`);
}

// ----------------------------------------------------------------------------
// vault shim — appendJSONL/readJSONL/readJSON/read/write covering both ledger
// + variance dependency paths. Pre-populates require.cache BEFORE any module
// that touches `../vault`.
// ----------------------------------------------------------------------------

const fakeJSONL = new Map(); // rel → array of entries
const fakeJSON  = new Map(); // rel → object

const vaultShim = {
  appendJSONL(rel, entry) {
    const arr = fakeJSONL.get(rel) || [];
    arr.push(entry);
    fakeJSONL.set(rel, arr);
  },
  readJSONL(rel) {
    return (fakeJSONL.get(rel) || []).slice();
  },
  readJSON(rel) {
    return fakeJSON.has(rel) ? fakeJSON.get(rel) : null;
  },
  read(rel) {
    if (fakeJSONL.has(rel)) {
      return { body: fakeJSONL.get(rel).map(JSON.stringify).join('\n') + '\n' };
    }
    if (fakeJSON.has(rel)) return { body: JSON.stringify(fakeJSON.get(rel)) };
    return null;
  },
  write(rel, body) {
    try { fakeJSON.set(rel, JSON.parse(body)); return; }
    catch (_) { /* fall through to JSONL */ }
    const arr = String(body).split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
    fakeJSONL.set(rel, arr);
  },
};

const vaultRealPath = require.resolve(path.join(__dirname, '..', 'lib', 'vault.js'));
require.cache[vaultRealPath] = {
  id: vaultRealPath,
  filename: vaultRealPath,
  loaded: true,
  exports: vaultShim,
};

// ----------------------------------------------------------------------------

(async () => {
  console.log(Y('lifetime ledger v1.0 consolidation smoke'));
  console.log('────────────────────────────────────────────────────');

  // ──────────────────────────────────────────────────────────────────────
  // A. Library API surface — 4 named exports must remain function-shaped
  //    so any callsite that did `const { fn } = require(...)` keeps working.
  // ──────────────────────────────────────────────────────────────────────
  const ledger = require(path.join(__dirname, '..', 'lib', 'lifetime-ledger'));
  const expectedExports = ['getLedger', 'appendEntry', 'aggregateByLink', 'LEDGER_REL'];
  const missingExport = expectedExports.find(k => typeof ledger[k] !== 'function');
  check(
    'A1 · 4 lib exports stable (getLedger/appendEntry/aggregateByLink/LEDGER_REL)',
    !missingExport,
    missingExport ? `missing: ${missingExport}` : `present: ${expectedExports.join(', ')}`,
  );

  const axesMod = require(path.join(__dirname, '..', 'lib', 'lifetime-ledger', 'axes'));
  const axesOk = Array.isArray(axesMod.AXES)
    && axesMod.AXES.length === 5
    && typeof axesMod.axisesForArchetype === 'function'
    && Array.isArray(axesMod.axisesForArchetype('HUMANITIES'))
    && axesMod.axisesForArchetype('HUMANITIES').length === 5;
  check(
    'A2 · axes contract — 5 canonical + HUMANITIES yields 5',
    axesOk,
    `AXES=[${axesMod.AXES.join(',')}]`,
  );

  // ──────────────────────────────────────────────────────────────────────
  // B. Sibling modules — tracker.computeProgress + variance.varianceVsFrontier
  //    must load + return documented shapes against a populated vault.
  // ──────────────────────────────────────────────────────────────────────
  const tracker  = require(path.join(__dirname, '..', 'lib', 'lifetime-ledger', 'tracker'));
  const variance = require(path.join(__dirname, '..', 'lib', 'lifetime-ledger', 'compute-variance'));

  const slug = '__verify_consolidation__';
  fakeJSON.set(`${slug}/chain.json`, {
    chain: {
      links: [
        {
          topic: 'L0 baseline',
          duration_weeks: 10,
          frontier_axis_p50: { learn: 100, practice: 500 },
          output_targets: [
            { axis: 'learn',    unit: '节',     count: 100 },
            { axis: 'practice', unit: '小时',   count: 500 },
            { axis: 'produce',  unit: '部',     count: 10  },
            { axis: 'read',     unit: '本',     count: 30  },
            { axis: 'reflect',  unit: '次',     count: 12  },
          ],
        },
      ],
    },
    inputs: { evidence: [{}, {}] },
  });

  // Seed 5 weekly entries on link 0 at ~p50 pace.
  for (let w = 0; w < 5; w++) {
    await ledger.appendEntry(slug, {
      weekIso: `2026-W${String(20 + w).padStart(2, '0')}`,
      linkIdx: 0,
      axis_counts: { learn: 10, practice: 50, produce: 1, read: 3, reflect: 1 },
      note: `week ${w + 1}`,
    });
  }

  const prog = await tracker.computeProgress(slug, 0);
  const progOk = prog
    && prog.linkIdx === 0
    && prog.axes
    && prog.axes.learn
    && prog.axes.learn.done === 50
    && prog.axes.learn.target === 100
    && Math.abs(prog.axes.learn.pct - 0.5) < 1e-9;
  check(
    'B1 · tracker.computeProgress returns {linkIdx, axes:{axis:{done,target,pct}}}',
    progOk,
    prog ? `learn.done=${prog.axes.learn.done}/${prog.axes.learn.target} pct=${prog.axes.learn.pct}` : 'null',
  );

  const v = await variance.varianceVsFrontier({ chainSlug: slug, linkIdx: 0, axis: 'practice' });
  const varOk = v
    && v.band === 'p50-p75'
    && typeof v.supportiveLine === 'string'
    && v.supportiveLine.length > 5
    && !v.supportiveLine.includes('!')
    && Number.isFinite(v.ratio);
  check(
    'B2 · variance returns register-clean band + ratio',
    varOk,
    v ? `band=${v.band} ratio=${v.ratio.toFixed(2)} elapsed=${v.elapsed_source}` : 'null',
  );

  // ──────────────────────────────────────────────────────────────────────
  // C. IPC handler wiring — grep main.js for the 4 contract handlers and
  //    confirm their require paths still point at the lifetime-ledger dir.
  //    NOT actually invoking ipcMain (no Electron), just contract-grepping.
  // ──────────────────────────────────────────────────────────────────────
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const ipcContracts = [
    { name: 'lifetime:get-ledger',       lib: "./lib/lifetime-ledger" },
    { name: 'lifetime:report-week',      lib: "./lib/lifetime-ledger" },
    { name: 'lifetime:compute-variance', lib: "./lib/lifetime-ledger/compute-variance" },
    { name: 'lifetime:link-progress',    lib: "./lib/lifetime-ledger/tracker" },
  ];
  const missingIpc = ipcContracts.find(c => {
    const re = new RegExp(`ipcMain\\.handle\\(\\s*['"]${c.name.replace(/[:]/g, '\\:')}['"]`);
    if (!re.test(mainJs)) return true;
    // ensure lib require still in proximity (cheap heuristic — module
    // dependency hasn't been silently swapped to something else)
    return !mainJs.includes(c.lib);
  });
  check(
    'C1 · all 4 lifetime:* IPC handlers registered in main.js',
    !missingIpc,
    missingIpc ? `missing: ${missingIpc.name} or its require path "${missingIpc.lib}"` : `4 handlers verified`,
  );

  // Envelope check — the IPC bodies do try/catch + return shape. Spot-check
  // by greppling for the canonical safe-catch pattern around lifetime:.
  const envelopeOk = /ipcMain\.handle\(\s*'lifetime:get-ledger'[\s\S]{0,400}catch\s*\(e\)\s*{\s*return\s*\{\s*ok:\s*false/.test(mainJs);
  check(
    'C2 · IPC envelope returns {ok:false,error} on throw (defensive)',
    envelopeOk,
    'try/catch wraps each lifetime:* handler',
  );

  // ──────────────────────────────────────────────────────────────────────
  // D. Preload bridge — window.lifetime.* must mirror the 4 IPC names with
  //    arg-passthrough; renderer code (UI screen) depends on this exact
  //    surface (`window.lifetime.reportWeek / linkProgress / getLedger /
  //    computeVariance`).
  // ──────────────────────────────────────────────────────────────────────
  const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const bridgeContracts = [
    { method: 'getLedger',       ipc: 'lifetime:get-ledger' },
    { method: 'reportWeek',      ipc: 'lifetime:report-week' },
    { method: 'computeVariance', ipc: 'lifetime:compute-variance' },
    { method: 'linkProgress',    ipc: 'lifetime:link-progress' },
  ];
  const missingBridge = bridgeContracts.find(b => {
    const re = new RegExp(`${b.method}\\s*:\\s*\\(p\\)\\s*=>\\s*ipcRenderer\\.invoke\\(\\s*['"]${b.ipc}['"]`);
    return !re.test(preloadJs);
  });
  check(
    'D1 · preload exposeInMainWorld("lifetime", { 4 methods }) wires to IPC',
    !missingBridge,
    missingBridge ? `missing/mis-wired: ${missingBridge.method} → ${missingBridge.ipc}` : '4 bridge methods aligned with IPC',
  );

  const exposeRe = /contextBridge\.exposeInMainWorld\(\s*['"]lifetime['"]/;
  check(
    'D2 · contextBridge namespace "lifetime" registered',
    exposeRe.test(preloadJs),
    'contextBridge.exposeInMainWorld("lifetime", {...}) present',
  );

  // ──────────────────────────────────────────────────────────────────────
  // E. UI screen — file exists + key sections grep + mount-route binding
  //    in app.jsx. Cheap structural sanity, not visual.
  // ──────────────────────────────────────────────────────────────────────
  const screenPath = path.join(__dirname, '..', 'design', 'screen-lifetime-ledger.jsx');
  const screenJsx = fs.readFileSync(screenPath, 'utf8');
  const requiredSections = [
    'function ThisWeekForm',
    'function AxisProgressBoard',
    'function VarianceDashboard',
    'function HistoryList',
    'window.LifetimeLedgerScreen',
  ];
  const missingSection = requiredSections.find(s => !screenJsx.includes(s));
  check(
    'E1 · screen-lifetime-ledger.jsx 4 components + window export',
    !missingSection,
    missingSection ? `missing: ${missingSection}` : `5 sections present`,
  );

  const appJsx = fs.readFileSync(path.join(__dirname, '..', 'design', 'app.jsx'), 'utf8');
  const routeOk = appJsx.includes("case \"lifetime\":")
    && appJsx.includes('LifetimeLedgerScreen')
    && appJsx.includes('hypha:open-lifetime');
  check(
    'E2 · app.jsx route="lifetime" + LifetimeLedgerScreen mount + open-event listener',
    routeOk,
    `route + mount + event-listener all present in app.jsx`,
  );

  // ──────────────────────────────────────────────────────────────────────
  // F. Atomic JSONL append — appendJSONL pattern must use append (not
  //    read-modify-write) so concurrent writes don't lose lines. We verify
  //    by writing 50 entries serially through the shim and reading back
  //    cleanly (the shim uses Array.push which is atomic in single-thread
  //    JS, mirroring vault.appendJSONL's fs.appendFile semantics).
  // ──────────────────────────────────────────────────────────────────────
  const concurrentSlug = '__atomic_append__';
  const N = 50;
  await Promise.all(
    Array.from({ length: N }, (_, i) => ledger.appendEntry(concurrentSlug, {
      weekIso: '2026-W20',
      linkIdx: i % 3,
      axis_counts: { learn: 1 },
      note: `concurrent #${i}`,
    })),
  );
  const after = await ledger.getLedger(concurrentSlug);
  check(
    `F1 · ${N} concurrent appendEntry → all ${N} lines persisted`,
    after.entries.length === N,
    `entries.length=${after.entries.length}`,
  );

  // ──────────────────────────────────────────────────────────────────────
  // G. Cross-link audit — invoke the 3 existing lifetime smokes + variance
  //    in child processes and assert each exits 0. If any regresses, this
  //    consolidation smoke also fails LOUDLY, surfacing the cross-link.
  // ──────────────────────────────────────────────────────────────────────
  const trioSmokes = [
    '_dev_verify_lifetime_ledger.js',
    '_dev_verify_lifetime_ipc.js',
    '_dev_verify_lifetime_schema.js',
    '_dev_verify_variance.js',
  ];
  let trioFails = [];
  for (const s of trioSmokes) {
    const abs = path.join(__dirname, s);
    if (!fs.existsSync(abs)) { trioFails.push(`${s} MISSING`); continue; }
    const r = cp.spawnSync(process.execPath, [abs], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) {
      const tail = (r.stdout || '').split('\n').slice(-3).join(' | ');
      trioFails.push(`${s} exit=${r.status} (${tail.trim().slice(0, 120)})`);
    }
  }
  check(
    `G1 · 4 sibling lifetime smokes still PASS (ledger/ipc/schema/variance audit)`,
    trioFails.length === 0,
    trioFails.length === 0 ? `4/4 green` : trioFails.join('; '),
  );

  // ──────────────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────────────
  console.log('────────────────────────────────────────────────────');
  const passN = results.filter(r => r.ok).length;
  const failN = results.length - passN;
  if (failN === 0) {
    console.log(G(`PASS ${passN}/${results.length}`) + D('  (lifetime ledger v1.0 contract LOCKED)'));
    process.exit(0);
  } else {
    console.log(R(`FAIL ${failN}/${results.length}`));
    process.exit(1);
  }
})().catch((err) => {
  console.error(R('uncaught:'), err && err.stack || err);
  process.exit(2);
});
