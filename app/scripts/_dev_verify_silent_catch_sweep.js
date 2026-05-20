#!/usr/bin/env node
/**
 * _dev_verify_silent_catch_sweep.js — v1.0 boot-7 hardening smoke.
 *
 * Lock the cleaned post-sweep silent-catch counts as a ceiling. Per
 * `silent_catch_hides_typeerror` memory (2026-05-13 vault.delete vs
 * vault.del incident hid TypeError for hours): any destructive op
 * (write / delete / exec) MUST NOT use bare `catch (_) {}`.
 *
 * 6 tests:
 *  T1  app/lib/+app/main.js silent-catch ceiling
 *  T2  vault.js silent catches that remain all carry `// intentional:`
 *  T3  high-impact destructive callsites now explicit (vault.del rollback paths)
 *  T4  fs.unlinkSync callsites either explicit OR carry `intentional:` tmp-may-not-exist comment
 *  T5  vault.del / vault.delete usage — no callsite uses `.delete` (the boot-7 incident pattern)
 *  T6  vault.js exports both `.del` AND `.exists` (the API surface destructive callers depend on)
 */

'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIB_DIR = path.join(REPO_ROOT, 'app', 'lib');
const MAIN_JS = path.join(REPO_ROOT, 'app', 'main.js');
const VAULT_JS = path.join(LIB_DIR, 'vault.js');

// Lock at observed post-sweep ceiling. Future cleanup is welcome to lower
// these — but never raise without explicit user approval.
const CEILING_LIB = 150;     // observed 143 post-sweep; tiny headroom for normal churn
const CEILING_MAIN = 130;    // observed 122 post-sweep

const SILENT_CATCH_RE = /catch\s*\(\s*_\s*\)\s*\{\s*\}/g;
const SILENT_CATCH_INTENTIONAL_RE = /catch\s*\(\s*_\s*\)\s*\{[\s\S]*?\}\s*(?:\/\/|\/\*)\s*intentional/;

function listJsRecursive(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
    }
  }
  walk(dir);
  return out;
}

function countSilent(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const m = text.match(SILENT_CATCH_RE);
  return m ? m.length : 0;
}

function fail(t, msg) { console.error(`  FAIL ${t}: ${msg}`); return false; }
function pass(t, msg) { console.log(`  PASS ${t}: ${msg}`); return true; }

let okCount = 0, total = 0;

// ──────────────────────────────────────────────────────────────────────────
// T1: silent-catch ceiling on app/lib + app/main.js
// ──────────────────────────────────────────────────────────────────────────
total++;
{
  let libTotal = 0;
  for (const f of listJsRecursive(LIB_DIR)) libTotal += countSilent(f);
  const mainTotal = countSilent(MAIN_JS);
  console.log(`\n[T1] silent-catch ceiling — lib=${libTotal} (ceil ${CEILING_LIB}) main=${mainTotal} (ceil ${CEILING_MAIN})`);
  if (libTotal > CEILING_LIB) {
    okCount += fail('T1a', `lib silent count ${libTotal} > ceiling ${CEILING_LIB}`) ? 1 : 0;
  } else if (mainTotal > CEILING_MAIN) {
    okCount += fail('T1b', `main silent count ${mainTotal} > ceiling ${CEILING_MAIN}`) ? 1 : 0;
  } else {
    okCount += pass('T1', `under ceiling`) ? 1 : 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// T2: vault.js — every remaining `catch (_) {}` carries `// intentional:`
//      (or `/* intentional */` flavor). vault.js is the load-bearing
//      destructive surface — no silent catches allowed without intent comment.
// ──────────────────────────────────────────────────────────────────────────
total++;
{
  console.log(`\n[T2] vault.js silent catches all annotated`);
  const text = fs.readFileSync(VAULT_JS, 'utf-8');
  const lines = text.split(/\r?\n/);
  const offenders = [];
  lines.forEach((line, i) => {
    if (SILENT_CATCH_RE.test(line)) {
      // reset regex (global)
      SILENT_CATCH_RE.lastIndex = 0;
      // Check this line carries intentional marker OR the immediately adjacent comment line
      const same = /intentional/.test(line);
      const next = lines[i + 1] && /^\s*\/[\/\*].*intentional/.test(lines[i + 1]);
      const prev = lines[i - 1] && /^\s*\/[\/\*].*intentional/.test(lines[i - 1]);
      if (!same && !next && !prev) offenders.push({ lineNo: i + 1, line: line.trim() });
    }
    SILENT_CATCH_RE.lastIndex = 0;
  });
  if (offenders.length > 0) {
    okCount += fail('T2', `vault.js has ${offenders.length} silent catch(es) without 'intentional' marker: ` + JSON.stringify(offenders.slice(0, 3))) ? 1 : 0;
  } else {
    okCount += pass('T2', `0 unmarked silent catches in vault.js`) ? 1 : 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// T3: high-impact destructive callsites in main.js now have explicit error
//      logging (not bare `catch (_) {}`). Pattern: every line containing
//      `vault.del(slug)` or `vault.del(warnRel)` must NOT end with
//      `} catch (_) {}` — it should have a multi-line catch with logging.
// ──────────────────────────────────────────────────────────────────────────
total++;
{
  console.log(`\n[T3] vault.del destructive callsites have explicit error handling`);
  const text = fs.readFileSync(MAIN_JS, 'utf-8');
  // Match a complete try { vault.del(...) } catch (_) {} on a single line
  const bareDelRe = /try\s*\{\s*vault\.del\([^)]+\)\s*;?\s*\}\s*catch\s*\(\s*_\s*\)\s*\{\s*\}/g;
  const offenders = [];
  let m;
  while ((m = bareDelRe.exec(text)) !== null) offenders.push(m[0].slice(0, 80));
  // Also bare vault.del that conditionally guards (e.g. `if (vault.exists...) vault.del`)
  // — we keep the boot-7 example which is now multi-line — so detect the line-level pattern only.
  // Allow the conditional version since the boot-7 example was already lifted to multi-line.
  if (offenders.length > 0) {
    okCount += fail('T3', `${offenders.length} bare vault.del+silent-catch sites still in main.js: ${JSON.stringify(offenders.slice(0, 3))}`) ? 1 : 0;
  } else {
    okCount += pass('T3', `0 bare vault.del + silent-catch in main.js`) ? 1 : 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// T4: fs.unlinkSync callsites that ARE silently caught must carry an
//      `intentional:` comment within ±1 line. (atomic-write tmp cleanup is
//      legitimately silent — but should declare intent.)
// ──────────────────────────────────────────────────────────────────────────
total++;
{
  console.log(`\n[T4] fs.unlinkSync silent catches declare intent`);
  const text = fs.readFileSync(MAIN_JS, 'utf-8');
  const lines = text.split(/\r?\n/);
  const offenders = [];
  lines.forEach((line, i) => {
    if (/fs\.unlinkSync\(/.test(line) && /catch\s*\(\s*_\s*\)\s*\{\s*\}\s*$/.test(line.trim())) {
      const same = /intentional/.test(line);
      const next = lines[i + 1] && /intentional/.test(lines[i + 1]);
      const prev = lines[i - 1] && /intentional/.test(lines[i - 1]);
      if (!same && !next && !prev) offenders.push({ lineNo: i + 1, line: line.trim().slice(0, 100) });
    }
  });
  if (offenders.length > 0) {
    okCount += fail('T4', `${offenders.length} fs.unlinkSync silent catches without intent: ` + JSON.stringify(offenders.slice(0, 3))) ? 1 : 0;
  } else {
    okCount += pass('T4', `every silent unlinkSync catch declares intent`) ? 1 : 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// T5: NO callsite uses `vault.delete(` — only `vault.del(`. The boot-7
//      incident (2026-05-13) was caused by `vault.delete()` being called
//      when only `.del()` exists; silent catch hid the TypeError for hours.
// ──────────────────────────────────────────────────────────────────────────
total++;
{
  console.log(`\n[T5] no caller uses non-existent vault.delete()`);
  const allFiles = [MAIN_JS, ...listJsRecursive(LIB_DIR)];
  const offenders = [];
  for (const f of allFiles) {
    const text = fs.readFileSync(f, 'utf-8');
    // vault.delete( as a method call — but allow vault.deleteX or vault.del( prefix
    const matches = text.match(/vault\.delete\(/g);
    if (matches) offenders.push({ file: path.relative(REPO_ROOT, f), count: matches.length });
  }
  if (offenders.length > 0) {
    okCount += fail('T5', `vault.delete(...) called somewhere — that method does NOT exist on vault module: ${JSON.stringify(offenders)}`) ? 1 : 0;
  } else {
    okCount += pass('T5', `no caller invokes non-existent vault.delete()`) ? 1 : 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// T6: vault.js exports both `del` AND `exists` (the API surface destructive
//      callers depend on; if either disappears, T5's grep stops being a
//      meaningful guard).
// ──────────────────────────────────────────────────────────────────────────
total++;
{
  console.log(`\n[T6] vault.js exports del + exists`);
  const text = fs.readFileSync(VAULT_JS, 'utf-8');
  const exportBlock = text.match(/module\.exports\s*=\s*\{[\s\S]*?\};/);
  if (!exportBlock) {
    okCount += fail('T6', `vault.js has no module.exports = { ... } block`) ? 1 : 0;
  } else {
    const hasDel = /\bdel\b/.test(exportBlock[0]);
    const hasExists = /\bexists\b/.test(exportBlock[0]);
    if (hasDel && hasExists) {
      okCount += pass('T6', `vault exports {del, exists}`) ? 1 : 0;
    } else {
      okCount += fail('T6', `missing exports — del=${hasDel} exists=${hasExists}`) ? 1 : 0;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
console.log(`\n[silent-catch-sweep] ${okCount}/${total} PASS\n`);
process.exit(okCount === total ? 0 : 1);
