#!/usr/bin/env node
'use strict';

// HYPHA v0.4.11 — backfill chain.parent_chain_slug from legacy state.series.
//
// Walks vault/* directories. For each course with a non-empty state.series and
// a chain.json that lacks parent_chain_slug, copies state.series into
// chain.parent_chain_slug and stamps parent_chain_updated_at. Atomic via
// tmp+rename mirror of v0.4.9 chain:edit-ultimate. Idempotent — second run
// reports 0 migrated.
//
// Flags:
//   --dry-run        preview without writing
//   --vault <path>   override default ./vault root
//
// Output mirrors the dev-script PASS/SKIP/FAIL pattern used elsewhere.

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const vaultArgIdx = argv.indexOf('--vault');
const ROOT = path.join(__dirname, '..', '..');
const VAULT = vaultArgIdx >= 0 && argv[vaultArgIdx + 1]
  ? path.resolve(argv[vaultArgIdx + 1])
  : path.join(ROOT, 'vault');

const PASS = (msg) => console.log(`  \x1b[32mPASS\x1b[0m ${msg}`);
const SKIP = (msg) => console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
const FAIL = (msg) => console.log(`  \x1b[31mFAIL\x1b[0m ${msg}`);

function listCourseDirs(vault) {
  if (!fs.existsSync(vault)) return [];
  return fs.readdirSync(vault, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => path.join(vault, d.name));
}

function atomicWriteJSON(absPath, obj) {
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, absPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* tmp may not exist */ }
    throw err;
  }
}

function run() {
  console.log(`HYPHA v0.4.11 · series → chain.parent_chain_slug migration${DRY_RUN ? ' (dry-run)' : ''}`);
  console.log(`vault: ${VAULT}`);
  if (!fs.existsSync(VAULT)) {
    SKIP(`vault not found at ${VAULT}`);
    return { scanned: 0, migrated: 0, skippedNoChain: 0, skippedAlready: 0, skippedNoSeries: 0, failed: 0 };
  }

  const stats = { scanned: 0, migrated: 0, skippedNoChain: 0, skippedAlready: 0, skippedNoSeries: 0, failed: 0 };
  const dirs = listCourseDirs(VAULT);

  for (const dir of dirs) {
    stats.scanned += 1;
    const slug = path.basename(dir);
    const statePath = path.join(dir, 'state.json');
    const chainPath = path.join(dir, 'chain.json');

    let state;
    try {
      if (!fs.existsSync(statePath)) {
        SKIP(`${slug} — no state.json`);
        stats.skippedNoSeries += 1;
        continue;
      }
      state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch (err) {
      FAIL(`${slug} — state.json read failed: ${err.message}`);
      stats.failed += 1;
      continue;
    }

    const series = (typeof state.series === 'string' && state.series.trim()) ? state.series.trim() : null;
    if (!series) {
      stats.skippedNoSeries += 1;
      continue;
    }

    if (!fs.existsSync(chainPath)) {
      SKIP(`${slug} — has series='${series}' but no chain.json`);
      stats.skippedNoChain += 1;
      continue;
    }

    let chain;
    try {
      chain = JSON.parse(fs.readFileSync(chainPath, 'utf-8'));
    } catch (err) {
      FAIL(`${slug} — chain.json read failed: ${err.message}`);
      stats.failed += 1;
      continue;
    }

    if (typeof chain.parent_chain_slug === 'string' && chain.parent_chain_slug) {
      stats.skippedAlready += 1;
      continue;
    }

    chain.parent_chain_slug = series;
    chain.parent_chain_updated_at = new Date().toISOString();

    if (DRY_RUN) {
      PASS(`${slug} — would migrate series='${series}'`);
      stats.migrated += 1;
      continue;
    }

    try {
      atomicWriteJSON(chainPath, chain);
      PASS(`${slug} — migrated series='${series}'`);
      stats.migrated += 1;
    } catch (err) {
      FAIL(`${slug} — atomic write failed: ${err.message}`);
      stats.failed += 1;
    }
  }

  return stats;
}

const stats = run();
console.log('');
console.log(`scanned: ${stats.scanned} | migrated: ${stats.migrated} | already: ${stats.skippedAlready} | no chain.json: ${stats.skippedNoChain} | no series: ${stats.skippedNoSeries} | failed: ${stats.failed}`);
process.exit(stats.failed === 0 ? 0 : 1);
