'use strict';

// _dev_verify_vault_safety.js — v1.0 boot-7 smoke
//
// 8 tests covering the vault safety triad: atomic write + snapshot lib +
// schema-version meta. Runs against a temp scratch vault (HYPHA_DATA env);
// never touches the real user vault.
//
// Run:
//   cd E:\victor\hypha
//   node app/scripts/_dev_verify_vault_safety.js
//
// Exit 0 = 8/8 pass. Exit 1 = any fail.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Set scratch vault BEFORE requiring vault libs (resolveRoot reads env once
// per call but vault.write etc. resolve fresh each time, so this is safe).
const SCRATCH = path.join(os.tmpdir(), 'hypha-vault-safety-' + Date.now());
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.HYPHA_DATA = SCRATCH;

const vault = require('../lib/vault');
const snapshot = require('../lib/vault-snapshot');
const meta = require('../lib/vault-meta');

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

function cleanup() {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (_) {}
}

async function main() {
  console.log(`\n[vault-safety] scratch = ${SCRATCH}\n`);

  // ---- TEST 1 — atomic write: power-cut simulation
  // Plant an orphan tmp file (as if the previous run crashed mid-rename) and
  // verify (a) vault.read on the real file returns null (not corrupted) and
  // (b) vault.list does not surface the tmp orphan as a note row.
  {
    fs.mkdirSync(path.join(SCRATCH, 'course-a'), { recursive: true });
    // Orphan tmp from a "crashed" write
    fs.writeFileSync(
      path.join(SCRATCH, 'course-a', 'lesson-0.md.tmp-9999-12345'),
      '--- truncated half-flush ---\nthis content is corrupted'
    );
    // Now do a real atomic write
    vault.write('course-a/lesson-0.md', '---\ntitle: clean\n---\n\nbody ok');
    const got = vault.read('course-a/lesson-0.md');
    check('1. atomic write — real file is clean post power-cut',
      got && got.body && got.body.includes('body ok'),
      `read body: ${got && got.body && got.body.slice(0, 60)}`);

    const list = vault.list();
    const courseA = list.folders.find(f => f.folder === 'course-a');
    const tmpVisible = courseA && courseA.items.some(it => it.label.includes('.tmp-'));
    check('2. atomic write — tmp orphan NOT visible in vault.list', !tmpVisible,
      `items: ${courseA && courseA.items.map(it => it.label).join(', ')}`);
  }

  // ---- TEST 3 — snapshot creates archive in vault/.snapshots/
  {
    vault.write('course-a/lesson-1.md', '---\ntitle: pre-snap\n---\n\nfirst content');
    const r = await snapshot.snapshotVault({ tag: 'unit-test' });
    check('3. snapshotVault creates .zip in vault/.snapshots/',
      r.ok && r.file && fs.existsSync(r.file) && r.file.includes(path.join('.snapshots')),
      `result: ${JSON.stringify(r)}`);
  }

  // ---- TEST 4 — listSnapshots returns sorted desc by ts
  {
    // Add another snapshot so we have ≥2
    await new Promise(res => setTimeout(res, 1100));  // ensure distinct YYYYMMDDTHHMMSS filename
    await snapshot.snapshotVault({ tag: 'second' });
    const list = snapshot.listSnapshots();
    const ok = list.length >= 2 && list[0].ts >= list[1].ts;
    check('4. listSnapshots returns sorted desc by ts', ok,
      `list: ${list.map(s => s.name + '@' + s.ts).join(' | ')}`);
  }

  // ---- TEST 5 — restoreSnapshot restores + creates pre-restore archive
  {
    // Snapshot now (state X), then mutate file, then restore — file should match X again
    vault.write('course-a/lesson-2.md', 'STATE_X');
    await new Promise(res => setTimeout(res, 1100));
    const snap = await snapshot.snapshotVault({ tag: 'restore-target' });
    vault.write('course-a/lesson-2.md', 'STATE_Y_MUTATED');
    const restored = await snapshot.restoreSnapshot(snap.ts);
    const reread = vault.read('course-a/lesson-2.md');
    check('5. restoreSnapshot restores file body + creates pre-restore archive',
      restored.ok &&
      reread && reread.body === 'STATE_X' &&
      restored.pre_restore && fs.existsSync(restored.pre_restore),
      `restored=${JSON.stringify({ ok: restored.ok, pre_restore: !!restored.pre_restore })} body="${reread && reread.body}"`);
  }

  // ---- TEST 6 — prune respects retention policy
  {
    // Aggressive prune: keep_recent=1, keep_daily=0, keep_weekly=0 — should leave 1.
    const before = snapshot.listSnapshots().length;
    const p = snapshot.pruneSnapshots({ keep_recent: 1, keep_daily: 0, keep_weekly: 0 });
    const after = snapshot.listSnapshots().length;
    check('6. pruneSnapshots respects retention (keep_recent=1)',
      p.ok && after === 1 && p.pruned.length === (before - 1),
      `before=${before} after=${after} pruned=${p.pruned.length}`);
  }

  // ---- TEST 7 — schema version tracking creates .vault-meta.json
  {
    const opened = meta.openVault('1.0.0-test');
    const metaAbs = path.join(SCRATCH, '.vault-meta.json');
    const onDisk = fs.existsSync(metaAbs) ? JSON.parse(fs.readFileSync(metaAbs, 'utf-8')) : null;
    check('7. openVault writes .vault-meta.json with schema_version',
      opened.ok && opened.bootstrapped &&
      onDisk && onDisk.schema_version === meta.CURRENT_SCHEMA_VERSION &&
      onDisk.last_app_version === '1.0.0-test',
      `opened=${JSON.stringify(opened)} onDisk=${JSON.stringify(onDisk)}`);
  }

  // ---- TEST 8 — stale schema detected → migration_needed flag + hook fires
  {
    // Hand-edit the meta to simulate a stale schema_version
    const metaAbs = path.join(SCRATCH, '.vault-meta.json');
    const cur = JSON.parse(fs.readFileSync(metaAbs, 'utf-8'));
    cur.schema_version = 0;  // pretend we're on a pre-v1.0 schema
    fs.writeFileSync(metaAbs, JSON.stringify(cur, null, 2));
    let hookFired = false;
    const opened = meta.openVault('1.0.0-test', { onMigrationRequired: (m) => {
      hookFired = m && m.schema_version === 0;
    } });
    check('8. stale schema detected → migration_needed + hook fires',
      opened.ok && opened.migration_needed === true && hookFired,
      `migration_needed=${opened.migration_needed} hookFired=${hookFired}`);
  }

  // ---- TEST 9 — regression: vault.readJSON / writeJSON shape unchanged
  {
    vault.writeJSON('course-a/state.json', { lesson: 0, archetype: 'TEST', concepts: ['a', 'b'] });
    const got = vault.readJSON('course-a/state.json');
    const fileExists = fs.existsSync(path.join(SCRATCH, 'course-a', 'state.json'));
    check('9. regression — vault.writeJSON/readJSON round-trip unchanged',
      got && got.lesson === 0 && got.archetype === 'TEST' && Array.isArray(got.concepts) && fileExists,
      `got=${JSON.stringify(got)}`);
  }

  console.log(`\n[vault-safety] ${pass} PASS / ${fail} FAIL\n`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log('  -', f.name, f.detail ? `(${f.detail})` : '');
  }
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[vault-safety] threw:', err);
  cleanup();
  process.exit(1);
});
