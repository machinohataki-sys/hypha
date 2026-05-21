#!/usr/bin/env node
/**
 * _dev_verify_icns_present.js
 *
 * Smoke for build/icon.icns presence + structural validity.
 * Closes the boot-10 hard blocker: ICNS missing → macOS DMG cannot ship branded.
 *
 * This smoke is FAIL-on-missing (unlike T3 in _dev_verify_build_dry_run.js,
 * which is advisory). When this smoke is green, the build chain is unblocked
 * for macOS DMG packaging.
 *
 * Usage: node app/scripts/_dev_verify_icns_present.js
 * Exit: 0 if all 5 pass, 1 otherwise.
 *
 * No deps, read-only.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ICNS_PATH = path.join(ROOT, 'build', 'icon.icns');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  const line = detail ? ` — ${detail}` : '';
  console.log(`[${tag}] ${name}${line}`);
}

function isValidPngBuf(buf) {
  return buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
    && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
}

// --- T1: file exists ---
let icnsBuf = null;
{
  const exists = fs.existsSync(ICNS_PATH);
  record('T1 build/icon.icns exists', exists,
    exists ? ICNS_PATH : 'missing — run `node build/generate-icns-from-png.js`');
  if (!exists) {
    // Cannot run further structural tests; report and exit.
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} tests passed.`);
    process.exit(1);
  }
  icnsBuf = fs.readFileSync(ICNS_PATH);
}

// --- T2: starts with 'icns' magic bytes ---
{
  const magic = icnsBuf.length >= 4 ? icnsBuf.slice(0, 4).toString('ascii') : '';
  const ok = magic === 'icns';
  record('T2 ICNS magic bytes', ok, ok ? `magic="${magic}"` : `got "${magic}" (need "icns")`);
}

// --- T3: file size > 1KB (real content, not a stub) ---
{
  const size = icnsBuf.length;
  const ok = size > 1024;
  record('T3 file size > 1KB (real content)', ok, `${size} B`);
}

// --- T4: total-size header field matches file size ---
{
  if (icnsBuf.length < 8) {
    record('T4 total-size header matches file size', false, 'file too short to read header');
  } else {
    const declared = icnsBuf.readUInt32BE(4);
    const actual = icnsBuf.length;
    const ok = declared === actual;
    record('T4 total-size header matches file size', ok,
      ok ? `${declared} B == ${actual} B` : `header says ${declared}, file is ${actual}`);
  }
}

// --- T5: at least 1 valid PNG entry payload ---
{
  let pos = 8;
  let pngCount = 0;
  const codes = [];
  let walkErr = null;
  while (pos + 8 <= icnsBuf.length) {
    const code = icnsBuf.slice(pos, pos + 4).toString('ascii');
    const entryLen = icnsBuf.readUInt32BE(pos + 4);
    if (entryLen < 8 || pos + entryLen > icnsBuf.length) {
      walkErr = `entry "${code}" at offset ${pos}: length ${entryLen} overflows file`;
      break;
    }
    const payload = icnsBuf.slice(pos + 8, pos + entryLen);
    if (isValidPngBuf(payload)) {
      pngCount++;
      codes.push(`${code}(${entryLen}B)`);
    }
    pos += entryLen;
  }
  if (walkErr) {
    record('T5 contains ≥ 1 valid PNG entry', false, walkErr);
  } else {
    const ok = pngCount >= 1;
    record('T5 contains ≥ 1 valid PNG entry', ok,
      ok ? `${pngCount} PNG entry(ies): ${codes.join(', ')}` : 'no PNG entries found');
  }
}

// --- Summary ---
const passed = results.filter((r) => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} tests passed.`);
if (passed !== total) {
  console.log('\nFailed:');
  for (const r of results) if (!r.ok) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
process.exit(0);
