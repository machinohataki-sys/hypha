#!/usr/bin/env node
'use strict';
// HYPHA · _dev_verify_file_converter — smoke for 4-level orchestrator.
//
// Validates app/lib/file-converter.js + each converter:
//   1. raw-stash always succeeds for any file ext
//   2. raw-extract handles .txt / .md natively
//   3. native-pdf returns ok:false for missing pdf-parse / file not found
//   4. native-epub returns ok:false for missing jszip / invalid epub
//   5. orchestrator falls through L1 → L2 → L3 → L4 cleanly
//   6. orchestrator NEVER throws when given a valid existing file
//   7. orchestrator carries `attempts` audit trail
//
// No real markitdown subprocess invoked — stub via Module._resolveFilename if
// needed; otherwise unsupported ext naturally falls past L1/L2.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tests = [];
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '\n    ' + extra : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-converter-smoke-'));

(async () => {

// ── Test 1: raw-stash always succeeds ───────────────────────────────────
{
  const { rawStash } = require('../lib/converters/raw-stash');
  const f = path.join(TMP, 'mystery.xyz');
  fs.writeFileSync(f, 'binary blob');
  const r = await rawStash(f);
  check('1. raw-stash — ok:true on any ext', r.ok === true);
  check('1. raw-stash — level === "raw-stash"', r.level === 'raw-stash');
  check('1. raw-stash — stub mdText contains filename', r.mdText.includes('mystery.xyz'));
  check('1. raw-stash — stats.original_bytes set', r.stats && r.stats.original_bytes === fs.statSync(f).size);
}

// ── Test 2: raw-extract handles .txt directly ───────────────────────────
{
  const { rawExtract } = require('../lib/converters/raw-extract');
  const f = path.join(TMP, 'notes.txt');
  fs.writeFileSync(f, 'hello\nworld\n');
  const r = await rawExtract(f);
  check('2. raw-extract — .txt ok:true', r.ok === true);
  check('2. raw-extract — .txt level === "raw-extract"', r.level === 'raw-extract');
  check('2. raw-extract — .txt mdText non-empty', r.mdText.length > 0);
}

// ── Test 3: raw-extract empty file → ok:false ───────────────────────────
{
  const { rawExtract } = require('../lib/converters/raw-extract');
  const f = path.join(TMP, 'empty.txt');
  fs.writeFileSync(f, '');
  const r = await rawExtract(f);
  check('3. raw-extract — empty txt ok:false', r.ok === false);
}

// ── Test 4: raw-extract unsupported ext → ok:false ──────────────────────
{
  const { rawExtract } = require('../lib/converters/raw-extract');
  const f = path.join(TMP, 'mystery.xyz');
  fs.writeFileSync(f, 'binary');
  const r = await rawExtract(f);
  check('4. raw-extract — unsupported ext ok:false', r.ok === false && /not supported/.test(r.reason));
}

// ── Test 5: native-pdf missing file → ok:false ──────────────────────────
{
  const { convertPdfNative } = require('../lib/converters/native-pdf');
  const r = await convertPdfNative('/no/such/path.pdf');
  check('5. native-pdf — missing file ok:false', r.ok === false);
}

// ── Test 6: native-epub missing file → ok:false ─────────────────────────
{
  const { convertEpubNative } = require('../lib/converters/native-epub');
  const r = await convertEpubNative('/no/such/path.epub');
  check('6. native-epub — missing file ok:false', r.ok === false);
}

// ── Test 7: orchestrator — .txt file should reach L3 raw-extract ────────
{
  const { convertFile } = require('../lib/file-converter');
  const f = path.join(TMP, 'hello.txt');
  fs.writeFileSync(f, 'hello world');
  const r = await convertFile(f);
  check('7. orchestrator — .txt resolves ok:true', r.ok === true);
  check('7. orchestrator — .txt level === "raw-extract" (no L1 for txt)', r.level === 'raw-extract');
  check('7. orchestrator — attempts array recorded', Array.isArray(r.attempts) && r.attempts.length >= 1);
}

// ── Test 8: orchestrator — unknown ext should reach L4 raw-stash ────────
{
  const { convertFile } = require('../lib/file-converter');
  const f = path.join(TMP, 'mystery.nokia');
  fs.writeFileSync(f, 'opaque blob');
  const r = await convertFile(f);
  check('8. orchestrator — unknown ext resolves ok:true', r.ok === true);
  check('8. orchestrator — unknown ext level === "raw-stash"', r.level === 'raw-stash');
  check('8. orchestrator — attempts records L1/L2/L3 skips/fails', r.attempts.length >= 3);
}

// ── Test 9: orchestrator NEVER throws on existing valid file ────────────
{
  const { convertFile } = require('../lib/file-converter');
  const f = path.join(TMP, 'whatever.bin');
  fs.writeFileSync(f, Buffer.from([0xff, 0x00, 0xde, 0xad, 0xbe, 0xef]));
  let threw = false;
  try { await convertFile(f); } catch (_) { threw = true; }
  check('9. orchestrator — never throws on binary blob', threw === false);
}

// ── Cleanup ─────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

// ── Report ──────────────────────────────────────────────────────────────
console.log('\n=== HYPHA · File Converter smoke ===\n');
for (const line of tests) console.log(line);
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} PASS\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

})();
