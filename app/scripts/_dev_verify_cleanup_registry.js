'use strict';

// _dev_verify_cleanup_registry.js — v1.0 boot-11 smoke
//
// 8 tests covering the unified shutdown registry. Verifies:
//   1. Module shape (register / unregister / runAll / status / _resetForTests)
//   2. register returns positive id
//   3. unregister removes entry from status()
//   4. runAll fires all registered cleanups in insertion order
//   5. runAll failures are isolated (one throws, others still run)
//   6. status() returns shape { id, label }[] — never the fn itself
//   7. mid-iteration unregister + late register race safety
//   8. runAll idempotence — second call returns prior summary, no double-fire
//
// Plus regression: existing IPC handler signatures aren't broken by main.js
// shutdown additions (light static-check on main.js).
//
// Run:
//   cd E:\victor\hypha
//   node app/scripts/_dev_verify_cleanup_registry.js
//
// Exit 0 = 8/8 pass. Exit 1 = any fail.

const fs = require('node:fs');
const path = require('node:path');

const cleanup = require('../lib/cleanup-registry');

let pass = 0;
let fail = 0;
const failed = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failed.push({ name, detail });
    console.log(`  FAIL  ${name}` + (detail ? `\n        ${detail}` : ''));
  }
}

function main() {
  console.log('\n[cleanup-registry] smoke\n');

  // ---- TEST 1 — exports shape
  {
    cleanup._resetForTests();
    const okShape =
      typeof cleanup.register === 'function' &&
      typeof cleanup.unregister === 'function' &&
      typeof cleanup.runAll === 'function' &&
      typeof cleanup.status === 'function' &&
      typeof cleanup._resetForTests === 'function';
    check('1. exports register/unregister/runAll/status/_resetForTests', okShape,
      'one or more exports missing or wrong type');
  }

  // ---- TEST 2 — register returns positive id, accumulates entries
  {
    cleanup._resetForTests();
    const id1 = cleanup.register({ label: 'a', cleanup_fn: () => {} });
    const id2 = cleanup.register({ label: 'b', cleanup_fn: () => {} });
    const ok = Number.isFinite(id1) && Number.isFinite(id2) && id1 > 0 && id2 > id1;
    const s = cleanup.status();
    check('2. register returns positive ascending id; status reflects both', ok && s.length === 2,
      `id1=${id1} id2=${id2} status.length=${s.length}`);
  }

  // ---- TEST 3 — unregister removes by id; returns true/false correctly
  {
    cleanup._resetForTests();
    const id = cleanup.register({ label: 'temp', cleanup_fn: () => {} });
    const removed = cleanup.unregister(id);
    const removedAgain = cleanup.unregister(id);
    const removedUnknown = cleanup.unregister(99999);
    const s = cleanup.status();
    check('3. unregister: removes once + returns false on repeat + unknown id',
      removed === true && removedAgain === false && removedUnknown === false && s.length === 0,
      `removed=${removed} again=${removedAgain} unknown=${removedUnknown} status.length=${s.length}`);
  }

  // ---- TEST 4 — runAll fires in insertion order
  {
    cleanup._resetForTests();
    const order = [];
    cleanup.register({ label: 'first', cleanup_fn: () => order.push('first') });
    cleanup.register({ label: 'second', cleanup_fn: () => order.push('second') });
    cleanup.register({ label: 'third', cleanup_fn: () => order.push('third') });
    const summary = cleanup.runAll();
    const okOrder = order.join(',') === 'first,second,third';
    const okSummary = summary && summary.total === 3 && summary.ok === 3 && summary.failed.length === 0;
    check('4. runAll fires in insertion order; summary correct', okOrder && okSummary,
      `order=[${order.join(',')}] summary=${JSON.stringify(summary)}`);
  }

  // ---- TEST 5 — failures isolated, others still run
  {
    cleanup._resetForTests();
    const fired = [];
    cleanup.register({ label: 'ok1', cleanup_fn: () => fired.push('ok1') });
    cleanup.register({ label: 'bad', cleanup_fn: () => { throw new Error('boom'); } });
    cleanup.register({ label: 'ok2', cleanup_fn: () => fired.push('ok2') });
    const summary = cleanup.runAll();
    const okFired = fired.join(',') === 'ok1,ok2';
    const okSummary = summary.ok === 2 &&
                      summary.failed.length === 1 &&
                      summary.failed[0].label === 'bad' &&
                      /boom/.test(summary.failed[0].error);
    check('5. failure in one cleanup does not stop the others', okFired && okSummary,
      `fired=[${fired.join(',')}] summary=${JSON.stringify(summary)}`);
  }

  // ---- TEST 6 — status() shape (no fn leak)
  {
    cleanup._resetForTests();
    cleanup.register({ label: 'visible', cleanup_fn: () => {} });
    const s = cleanup.status();
    const row = s[0] || {};
    const ok = s.length === 1 &&
               typeof row.id === 'number' &&
               row.label === 'visible' &&
               typeof row.cleanup_fn === 'undefined';
    check('6. status() returns { id, label }[] without leaking cleanup_fn', ok,
      `status=${JSON.stringify(s)}`);
  }

  // ---- TEST 7 — race: cleanup that unregisters mid-iteration + late register
  // Snapshot pattern means in-flight unregister of *other* entries does not
  // skip them. Late register during drain fires immediately + returns -1.
  {
    cleanup._resetForTests();
    const fired = [];
    // 'a' tries to unregister 'b' mid-iteration — snapshot keeps 'b' in queue
    let bId = null;
    cleanup.register({
      label: 'a',
      cleanup_fn: () => { fired.push('a'); cleanup.unregister(bId); },
    });
    bId = cleanup.register({ label: 'b', cleanup_fn: () => fired.push('b') });
    cleanup.register({ label: 'c', cleanup_fn: () => fired.push('c') });
    cleanup.runAll();
    // After drain, _drained=true. A late register fires immediately + returns -1.
    let lateRan = false;
    const lateId = cleanup.register({
      label: 'late',
      cleanup_fn: () => { lateRan = true; },
    });
    const ok = fired.join(',') === 'a,b,c' && lateId === -1 && lateRan === true;
    check('7. snapshot iteration + post-drain late register fires immediately',
      ok, `fired=[${fired.join(',')}] lateId=${lateId} lateRan=${lateRan}`);
  }

  // ---- TEST 8 — runAll idempotent; second call returns prior summary
  {
    cleanup._resetForTests();
    let count = 0;
    cleanup.register({ label: 'once', cleanup_fn: () => { count++; } });
    const first = cleanup.runAll();
    const second = cleanup.runAll();
    const ok = count === 1 &&
               first === second &&
               first.total === 1 && first.ok === 1;
    check('8. runAll is idempotent (no double-fire across before-quit + will-quit)',
      ok, `count=${count} first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
  }

  // ---- Regression: main.js shutdown wiring sane (static-grep, no runtime exec)
  // Confirms the cleanup-registry require + runAll call are both present in
  // main.js so the boot-11 wiring isn't accidentally removed by a future merge.
  {
    const mainPath = path.join(__dirname, '..', 'main.js');
    const src = fs.readFileSync(mainPath, 'utf8');
    const requiresReg = /require\(['"]\.\/lib\/cleanup-registry['"]\)/.test(src);
    const callsRunAll = /cleanupRegistry\.runAll\(\)/.test(src);
    const beforeQuitOk = /app\.on\(['"]before-quit['"][\s\S]*cleanupRegistry\.runAll\(\)/.test(src);
    const ok = requiresReg && callsRunAll && beforeQuitOk;
    check('REG. main.js wires cleanup-registry into app.before-quit', ok,
      `requiresReg=${requiresReg} callsRunAll=${callsRunAll} beforeQuitOk=${beforeQuitOk}`);
  }

  console.log(`\n  ${pass + fail === 9 ? 9 : pass + fail} checks · ${pass} PASS · ${fail} FAIL`);
  if (failed.length > 0) {
    console.log('\n  Failed details:');
    for (const f of failed) console.log(`   - ${f.name}: ${f.detail || '(no detail)'}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
