#!/usr/bin/env node
'use strict';
// HYPHA · _dev_backfill_lesson_body_v045 — one-shot survey for v0.4.5 schema.
//
// v0.4.5 (2026-05-19) added required body fields:
//   - expected_duration_min (15-50)
//   - transfer_cases (≥2 objects for APPLY state)
//   - practice_assignments (≥1 object for LATCH state)
//   - frameworks (HUMANITIES floor — ≥2)
//   - counter_cases (HUMANITIES floor — ≥1)
//   - answer_quality_rubric (tutor rubric)
//
// Existing bodies in vault (generated pre-v0.4.5) don't have these. This
// script SURVEYS them + flags _meta.thin_warning_v045 on each so the UI can
// show "needs refresh — manual /preview-regen". Does NOT auto-fill content
// (that needs LLM regen, see `lesson:body:regen` IPC).
//
// Idempotent: bodies already flagged skip.
//
// Usage:
//   node app/scripts/_dev_backfill_lesson_body_v045.js
//   node app/scripts/_dev_backfill_lesson_body_v045.js --dry-run
//   node app/scripts/_dev_backfill_lesson_body_v045.js --vault C:\custom\path

const path = require('path');
const fs = require('fs');
const os = require('os');

const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const vaultOverride = (() => {
  const i = argv.indexOf('--vault');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

function _resolveVaultRoot() {
  if (vaultOverride) return path.resolve(vaultOverride);
  try {
    const vaultLib = require('../lib/vault');
    return vaultLib.resolveRoot();
  } catch (_) {
    // Cross-platform userData fallback: use os.homedir() (process.env.HOME is empty on Windows).
    // Mirrors Electron's app.getPath('userData') defaults per platform.
    const home = os.homedir();
    if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'hypha-data');
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'hypha-data');
    return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'hypha-data');
  }
}

const vaultRoot = _resolveVaultRoot();
console.log('=== HYPHA · v0.4.5 Body Schema Backfill ===');
console.log(`vaultRoot: ${vaultRoot}`);
console.log(`dry-run:   ${isDryRun ? 'YES (no writes)' : 'NO (writes _meta.thin_warning_v045)'}\n`);

if (!fs.existsSync(vaultRoot)) {
  console.error(`vault not found at ${vaultRoot} — pass --vault <path>`);
  process.exit(1);
}

// Walk vault/<slug>/lesson-*.body.json
const slugDirs = fs.readdirSync(vaultRoot, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'data')
  .map(d => path.join(vaultRoot, d.name));

let scanned = 0, flagged = 0, fresh = 0, alreadyFlagged = 0, errors = 0;
const reports = [];

const v045_fields = ['expected_duration_min', 'transfer_cases', 'practice_assignments', 'frameworks', 'counter_cases', 'answer_quality_rubric'];

for (const slugDir of slugDirs) {
  if (!fs.existsSync(slugDir)) continue;
  const files = fs.readdirSync(slugDir).filter(f => /^lesson-\d+\.body\.json$/.test(f));
  for (const f of files) {
    scanned++;
    const bodyPath = path.join(slugDir, f);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(bodyPath, 'utf8'));
    } catch (e) {
      errors++;
      reports.push(`  ✗ ${path.basename(slugDir)}/${f}: parse failed — ${e.message}`);
      continue;
    }
    const body = (payload && payload.body) || payload;  // some bodies stored at top, some under .body
    if (!body || typeof body !== 'object') {
      errors++;
      reports.push(`  ✗ ${path.basename(slugDir)}/${f}: no body object`);
      continue;
    }
    const _meta = payload._meta || {};
    if (_meta.thin_warning_v045) {
      alreadyFlagged++;
      reports.push(`  · ${path.basename(slugDir)}/${f}: already flagged`);
      continue;
    }
    const missing = v045_fields.filter(field => body[field] === undefined || body[field] === null
      || (Array.isArray(body[field]) && body[field].length === 0));
    if (missing.length === 0) {
      fresh++;
      reports.push(`  ✓ ${path.basename(slugDir)}/${f}: v0.4.5-fresh (all fields present)`);
      continue;
    }
    // Flag with _meta.thin_warning_v045 — UI can render "this lesson body
    // predates v0.4.5; consider /preview-regen for transfer_cases + practice"
    payload._meta = {
      ..._meta,
      thin_warning_v045: {
        flagged_at: new Date().toISOString(),
        missing_fields: missing,
        suggestion: 'Use lesson preview regen to refresh body with v0.4.5 schema (transfer_cases, practice_assignments, etc.). APPLY state + LATCH practice may degrade until then.',
      },
    };
    if (!isDryRun) {
      try {
        fs.writeFileSync(bodyPath, JSON.stringify(payload, null, 2), 'utf8');
      } catch (e) {
        errors++;
        reports.push(`  ✗ ${path.basename(slugDir)}/${f}: write failed — ${e.message}`);
        continue;
      }
    }
    flagged++;
    reports.push(`  ⚠ ${path.basename(slugDir)}/${f}: flagged thin (missing: ${missing.join(', ')})`);
  }
}

for (const r of reports) console.log(r);
console.log(`\nScanned: ${scanned} · Fresh: ${fresh} · Flagged: ${flagged} · Already: ${alreadyFlagged} · Errors: ${errors}`);
if (isDryRun && flagged > 0) {
  console.log(`\nDRY RUN — re-run without --dry-run to persist ${flagged} thin_warning_v045 flag(s).`);
}
process.exit(errors > 0 && flagged === 0 ? 1 : 0);
