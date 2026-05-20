'use strict';
// Smoke verify: Commons Pack schema validator.
// PS1: rejects null / non-object
// PS2: rejects missing required fields
// PS3: rejects invalid archetype
// PS4: rejects invalid license
// PS5: accepts the shipped seed pack
// PS6: rejects malformed lesson (missing topic or invalid role)

const fs = require('node:fs');
const path = require('node:path');
const { validatePack } = require('../lib/commons/pack-schema');

const results = [];
function record(id, label, ok, detail) {
  results.push({ id, label, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  const line = `[${tag}] ${id} ${label}${detail ? ' — ' + detail : ''}`;
  console.log(line);
}

// ─── PS1: null / non-object inputs are rejected ─────────────────────────
(() => {
  const cases = [null, undefined, 'string', 42, [], true];
  let allBad = true;
  for (const c of cases) {
    const r = validatePack(c);
    if (r.ok) { allBad = false; break; }
  }
  record('PS1', 'rejects null/non-object inputs', allBad,
    allBad ? '' : 'one of null/undefined/string/number/array/bool slipped through');
})();

// ─── PS2: missing required fields rejected ──────────────────────────────
(() => {
  const required = ['id', 'name', 'version', 'archetype', 'license', 'author', 'lessons'];
  const base = {
    id: 'valid-id', name: 'Valid Name', version: '1.0.0', archetype: 'MINDSET',
    license: 'MIT', author: 'tester',
    lessons: [{ topic: 'x', role: 'core' }],
  };
  let allRejected = true;
  let firstMiss = null;
  for (const k of required) {
    const variant = { ...base };
    delete variant[k];
    const r = validatePack(variant);
    if (r.ok) { allRejected = false; firstMiss = k; break; }
  }
  record('PS2', 'rejects missing required fields',
    allRejected,
    allRejected ? '' : `missing "${firstMiss}" was accepted`);
})();

// ─── PS3: invalid archetype rejected ────────────────────────────────────
(() => {
  const variant = {
    id: 'arch-test', name: 'Arch Test', version: '1.0', archetype: 'NOT-A-THING',
    license: 'MIT', author: 'tester',
    lessons: [{ topic: 'x', role: 'core' }],
  };
  const r = validatePack(variant);
  const archErr = (r.errors || []).find(e => e.startsWith('archetype:'));
  record('PS3', 'rejects invalid archetype enum', !r.ok && !!archErr,
    r.ok ? 'accepted bogus archetype' : (archErr ? '' : 'rejected for wrong reason'));
})();

// ─── PS4: invalid license rejected ──────────────────────────────────────
(() => {
  const variant = {
    id: 'lic-test', name: 'Lic Test', version: '1.0', archetype: 'MINDSET',
    license: 'NOT-A-LICENSE', author: 'tester',
    lessons: [{ topic: 'x', role: 'core' }],
  };
  const r = validatePack(variant);
  const licErr = (r.errors || []).find(e => e.startsWith('license:'));
  record('PS4', 'rejects invalid license enum', !r.ok && !!licErr,
    r.ok ? 'accepted bogus license' : (licErr ? '' : 'rejected for wrong reason'));
})();

// ─── PS5: shipped seed pack passes validation ───────────────────────────
(() => {
  const seedPath = path.join(__dirname, '..', '..', 'vault', '.commons-packs', 'seed-feynman-method.json');
  let raw, pack, parseErr = null;
  try {
    raw = fs.readFileSync(seedPath, 'utf-8');
    pack = JSON.parse(raw);
  } catch (e) {
    parseErr = e.message;
  }
  if (parseErr) {
    record('PS5', 'seed pack loads + validates', false, 'parse fail: ' + parseErr);
    return;
  }
  const r = validatePack(pack);
  record('PS5', 'seed pack loads + validates', r.ok,
    r.ok ? `seed-feynman-method ok (${pack.lessons.length} lessons)` : 'errors: ' + JSON.stringify(r.errors));
})();

// ─── PS6: malformed lesson rejected ─────────────────────────────────────
(() => {
  const missingTopic = {
    id: 'lm-test-a', name: 'LM Test A', version: '1.0', archetype: 'MINDSET',
    license: 'MIT', author: 'tester',
    lessons: [{ role: 'core' }],
  };
  const badRole = {
    id: 'lm-test-b', name: 'LM Test B', version: '1.0', archetype: 'MINDSET',
    license: 'MIT', author: 'tester',
    lessons: [{ topic: 'x', role: 'bogus-role' }],
  };
  const r1 = validatePack(missingTopic);
  const r2 = validatePack(badRole);
  const r1err = (r1.errors || []).find(e => e.includes('topic'));
  const r2err = (r2.errors || []).find(e => e.includes('role'));
  const ok = !r1.ok && !!r1err && !r2.ok && !!r2err;
  record('PS6', 'rejects malformed lesson (missing topic | bad role)', ok,
    ok ? '' : `missingTopic.ok=${r1.ok} badRole.ok=${r2.ok}`);
})();

// ─── summary ────────────────────────────────────────────────────────────
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} PASS`);
if (passed !== total) {
  console.error('FAIL — see records above');
  process.exit(1);
}
process.exit(0);
