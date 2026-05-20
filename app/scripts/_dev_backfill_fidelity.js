#!/usr/bin/env node
'use strict';
// HYPHA · _dev_backfill_fidelity — one-shot migration.
//
// Re-scores existing Library book manifests that pre-date the 2026-05-19
// fidelity-scorer ship. Reads <book-id>.txt sidecar, runs scoreFidelity,
// writes fidelity_score + fidelity_tier + fidelity_breakdown to manifest.
//
// Idempotent: manifests already containing fidelity_score skip.
//
// Usage:
//   node app/scripts/_dev_backfill_fidelity.js
//   node app/scripts/_dev_backfill_fidelity.js --dry-run
//   node app/scripts/_dev_backfill_fidelity.js --vault C:\path\to\custom-vault
//
// HYPHA per-user vault lives at app.getPath('userData')/hypha-data by default,
// resolvable via app/lib/vault.js when in-process. Standalone script uses
// resolveRoot() too.

const path = require('path');
const fs = require('fs');
const os = require('os');

const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const isForce = argv.includes('--force'); // rescore even if fidelity_score already present (use after scorer recalibration)
const vaultOverride = (() => {
  const i = argv.indexOf('--vault');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

function _resolveVaultRoot() {
  if (vaultOverride) return path.resolve(vaultOverride);
  try {
    const vaultLib = require('../lib/vault');
    return vaultLib.resolveRoot();
  } catch (e) {
    // Cross-platform userData fallback: os.homedir() works on Win/Mac/Linux (process.env.HOME is empty on Windows).
    const home = os.homedir();
    if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'hypha-data');
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'hypha-data');
    return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'hypha-data');
  }
}

const vaultRoot = _resolveVaultRoot();
console.log('=== HYPHA · Backfill Fidelity Score ===');
console.log(`vaultRoot:  ${vaultRoot}`);
console.log(`dry-run:    ${isDryRun ? 'YES (no writes)' : 'NO (writes manifest)'}\n`);

if (!fs.existsSync(vaultRoot)) {
  console.error(`vault not found at ${vaultRoot}`);
  console.error('Pass --vault <path> to override.');
  process.exit(1);
}

const libraryDir = path.join(vaultRoot, 'data', 'library');
if (!fs.existsSync(libraryDir)) {
  console.log('No data/library dir — nothing to backfill.');
  process.exit(0);
}

const { scoreFidelity } = require('../lib/converters/fidelity-scorer');

const entries = fs.readdirSync(libraryDir, { withFileTypes: true })
  // Skip GraphRAG sidecars + chunk indexes — only book manifests have a top-level
  // `id` field. Filenames look like `<book-id>.graph.json` for graph data.
  .filter(e => e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.graph.json') && !e.name.endsWith('.chunks.json'));

console.log(`Found ${entries.length} manifest(s).\n`);

let scanned = 0, scored = 0, skipped = 0, errors = 0;
const reports = [];

for (const ent of entries) {
  scanned++;
  const manifestPath = path.join(libraryDir, ent.name);
  const textPath = manifestPath.replace(/\.json$/, '.txt');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    errors++;
    reports.push(`  ✗ ${ent.name}: parse failed — ${e.message}`);
    continue;
  }
  if (!manifest || !manifest.id) {
    errors++;
    reports.push(`  ✗ ${ent.name}: missing id field`);
    continue;
  }
  if (typeof manifest.fidelity_score === 'number' && !isForce) {
    skipped++;
    reports.push(`  · ${manifest.title || manifest.id}: already scored (${manifest.fidelity_score} ${manifest.fidelity_tier || ''}) — pass --force to rescore`);
    continue;
  }
  const prevScore = typeof manifest.fidelity_score === 'number' ? manifest.fidelity_score : null;
  if (!fs.existsSync(textPath)) {
    errors++;
    reports.push(`  ✗ ${manifest.title || manifest.id}: .txt sidecar missing — cannot re-score`);
    continue;
  }
  try {
    const text = fs.readFileSync(textPath, 'utf8');
    const fid = scoreFidelity({
      mdText: text,
      ext: manifest.type || 'unknown',
      expected_pages: manifest.page_count || undefined,
      parsed_level: manifest.parsed_level || 'unknown',
    });
    manifest.fidelity_score = fid.score;
    manifest.fidelity_tier = fid.tier;
    manifest.fidelity_breakdown = fid.breakdown;
    if (!isDryRun) {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    }
    scored++;
    const delta = (prevScore != null) ? ` (was ${prevScore})` : '';
    reports.push(`  ✓ ${manifest.title || manifest.id}: score=${fid.score} (${fid.tier})${delta} · ${manifest.parsed_level || '?'} · ${(text.length / 1000).toFixed(1)}k chars`);
  } catch (e) {
    errors++;
    reports.push(`  ✗ ${manifest.title || manifest.id}: scoring failed — ${e.message}`);
  }
}

for (const r of reports) console.log(r);
console.log(`\nScanned: ${scanned} · Scored: ${scored} · Skipped (already): ${skipped} · Errors: ${errors}`);
if (isDryRun && scored > 0) {
  console.log(`\nDRY RUN — re-run without --dry-run to persist ${scored} updated manifest(s).`);
}
process.exit(errors > 0 && scored === 0 ? 1 : 0);
