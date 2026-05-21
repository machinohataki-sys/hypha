'use strict';

// vault-snapshot.js — v1.0 boot-7
//
// Crash-recovery + pre-destructive-op snapshots of the user's vault.
// Snapshots are ZIP archives written to vault/.snapshots/<ts>-<tag>.zip.
// The .snapshots dir is hidden from vault.list (dotfile filter).
//
// Triggers (callers wire as needed):
//   - vault migration / schema bump        → snapshotVault({ tag: 'pre-migration' })
//   - pack import (Commons)                → snapshotVault({ tag: 'pre-pack-import' })
//   - commons sync                         → snapshotVault({ tag: 'pre-commons-sync' })
//   - first launch                         → snapshotVault({ tag: 'first-launch' })
//   - user-invoked manual backup           → snapshotVault({ tag: 'manual' })
//
// API surface (consumed by IPC `vault:snapshot`, `vault:list-snapshots`,
// `vault:restore-snapshot`):
//   snapshotVault({ tag })       → { ok, file, bytes, ts, tag }
//   listSnapshots()              → [{ name, file, ts, tag, bytes }, ...] (desc by ts)
//   restoreSnapshot(ts)          → { ok, restored_from, pre_restore }
//   pruneSnapshots(policy)       → { ok, kept, pruned }
//
// Design notes:
//   - jszip is already a dep (see package.json). No new install needed.
//   - We DO NOT touch vault data files outside .snapshots/. The whole vault
//     is read top-down, skipping .snapshots itself + .trash (already its own
//     soft-delete layer) + node_modules / .git noise. Hidden dotfile dirs are
//     preserved (.beiking, .hypha) — those carry user state.
//   - Restore archives current state to <ts>-pre-restore.zip BEFORE extraction,
//     so user can undo a bad restore. Per CLAUDE.md "vault safety" pillar.
//   - Retention: keep_recent=10 / keep_daily=7 / keep_weekly=4 (default).

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const vault = require('./vault');

const SNAPSHOT_DIR_NAME = '.snapshots';
const SKIP_TOP_LEVEL = new Set([SNAPSHOT_DIR_NAME, 'node_modules', '.git']);
// We never archive .trash because that's already soft-deleted data with its
// own purge cron; including it would balloon snapshot size.
const SKIP_ANYWHERE = new Set(['.trash']);

function _snapshotDir() {
  const root = vault.resolveRoot();
  const dir = path.join(root, SNAPSHOT_DIR_NAME);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _sanitizeTag(tag) {
  const raw = String(tag || 'manual').toLowerCase().trim();
  // Allow [a-z0-9-_], replace everything else. Cap at 40 chars to keep
  // filenames sane on Windows (260-char path limit).
  return raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'manual';
}

function _isoFilenameTs(ts) {
  // YYYYMMDDTHHMMSS for filename safety (no colons; Windows-friendly).
  return new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
}

function _walkVault(root) {
  // Returns array of { abs, rel } for every regular file under root, skipping
  // the snapshot/skip dirs. rel uses forward slashes (ZIP archive convention).
  const out = [];
  function walk(dir, prefix) {
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const d of dirents) {
      if (!prefix && SKIP_TOP_LEVEL.has(d.name)) continue;
      if (SKIP_ANYWHERE.has(d.name)) continue;
      const abs = path.join(dir, d.name);
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) walk(abs, rel);
      else if (d.isFile()) out.push({ abs, rel });
    }
  }
  walk(root, '');
  return out;
}

async function snapshotVault(opts) {
  const tag = _sanitizeTag(opts && opts.tag);
  const ts = Date.now();
  const root = vault.resolveRoot();
  if (!fs.existsSync(root)) return { ok: false, error: 'vault root missing' };

  const snapDir = _snapshotDir();
  const fileName = `${_isoFilenameTs(ts)}-${tag}.zip`;
  const file = path.join(snapDir, fileName);

  const zip = new JSZip();
  const files = _walkVault(root);
  for (const f of files) {
    try {
      const buf = fs.readFileSync(f.abs);
      zip.file(f.rel, buf);
    } catch (_) {
      // Skip unreadable files (locked by another process, sym-link to nowhere);
      // snapshot stays best-effort and reports the count we got.
    }
  }
  // STORE level only would skip compression; default DEFLATE level 6 gives
  // ~3-4x reduction on JSON/MD without notable CPU cost for typical vaults.
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  // Atomic: write tmp then rename so a power-cut mid-snapshot doesn't leave
  // a torn .zip readable as "valid" by listSnapshots.
  const tmpAbs = `${file}.tmp-${process.pid}-${ts}`;
  try {
    fs.writeFileSync(tmpAbs, buf);
    fs.renameSync(tmpAbs, file);
  } catch (err) {
    try { fs.unlinkSync(tmpAbs); } catch (_) {}
    return { ok: false, error: `snapshot write failed: ${err.message}` };
  }
  return { ok: true, file, bytes: buf.length, ts, tag, fileCount: files.length };
}

function listSnapshots() {
  const snapDir = _snapshotDir();
  let dirents;
  try { dirents = fs.readdirSync(snapDir, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    if (!d.name.endsWith('.zip')) continue;
    if (d.name.includes('.tmp-')) continue;  // torn tmp; ignore
    // Filename: YYYYMMDDTHHMMSS-<tag>.zip — parse back to ts.
    const m = d.name.match(/^(\d{8}T\d{6})-(.+)\.zip$/);
    if (!m) continue;
    const iso = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}T${m[1].slice(9, 11)}:${m[1].slice(11, 13)}:${m[1].slice(13, 15)}Z`;
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) continue;
    const abs = path.join(snapDir, d.name);
    let bytes = 0;
    try { bytes = fs.statSync(abs).size; } catch (_) {}
    out.push({ name: d.name, file: abs, ts, tag: m[2], bytes });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

async function restoreSnapshot(ts) {
  // listSnapshots derives ts from the filename (second precision), while
  // snapshotVault returns Date.now() (ms precision). Match within 1500ms so
  // a caller can pass either form (the ms-precision Date.now() OR the
  // second-precision ts from listSnapshots).
  const snaps = listSnapshots();
  const target = Number(ts);
  let match = snaps.find(s => s.ts === target);
  if (!match) {
    match = snaps.find(s => Math.abs(s.ts - target) < 1500);
  }
  if (!match) return { ok: false, error: 'snapshot not found for ts' };

  // Stage 1: archive current state as <ts>-pre-restore.zip so user can undo.
  const pre = await snapshotVault({ tag: 'pre-restore' });
  if (!pre.ok) return { ok: false, error: `pre-restore snapshot failed: ${pre.error}` };

  // Stage 2: read the target archive + extract over root. We do NOT wipe the
  // root first — that would risk killing the .snapshots/ folder itself (we
  // archive it OUT in pre-restore, so it's safe, but partial-extract-then-
  // crash would leave a vault with no recovery path). Instead, walk the zip
  // and replace each file individually via vault.write semantics (tmp+rename
  // implied — we go straight to fs here for raw bytes).
  let buf;
  try { buf = fs.readFileSync(match.file); }
  catch (err) { return { ok: false, error: `read archive failed: ${err.message}` }; }
  let zip;
  try { zip = await JSZip.loadAsync(buf); }
  catch (err) { return { ok: false, error: `parse archive failed: ${err.message}` }; }

  const root = vault.resolveRoot();
  const entries = Object.values(zip.files).filter(z => !z.dir);
  for (const entry of entries) {
    const safe = path.normalize(entry.name).replace(/^[\\/]+/, '');
    const abs = path.resolve(root, safe);
    if (!abs.startsWith(path.resolve(root))) continue;  // path traversal guard
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const fileBuf = await entry.async('nodebuffer');
    const tmpAbs = `${abs}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmpAbs, fileBuf);
      fs.renameSync(tmpAbs, abs);
    } catch (err) {
      try { fs.unlinkSync(tmpAbs); } catch (_) {}
      return { ok: false, error: `restore write failed at ${entry.name}: ${err.message}`, pre_restore: pre.file };
    }
  }
  return { ok: true, restored_from: match.file, pre_restore: pre.file, fileCount: entries.length };
}

// Retention: keep N most recent + N daily + N weekly. Default 10/7/4.
function pruneSnapshots(policy) {
  const p = policy || {};
  const keepRecent = Number.isFinite(p.keep_recent) ? p.keep_recent : 10;
  const keepDaily = Number.isFinite(p.keep_daily) ? p.keep_daily : 7;
  const keepWeekly = Number.isFinite(p.keep_weekly) ? p.keep_weekly : 4;

  const snaps = listSnapshots();
  const keep = new Set();

  // Layer 1: most-recent N.
  for (let i = 0; i < Math.min(keepRecent, snaps.length); i++) keep.add(snaps[i].name);

  // Layer 2: 1 per UTC day, up to keepDaily distinct days.
  const seenDay = new Set();
  for (const s of snaps) {
    const day = new Date(s.ts).toISOString().slice(0, 10);
    if (seenDay.has(day)) continue;
    if (seenDay.size >= keepDaily) break;
    seenDay.add(day);
    keep.add(s.name);
  }

  // Layer 3: 1 per ISO-week, up to keepWeekly distinct weeks.
  const seenWeek = new Set();
  for (const s of snaps) {
    const d = new Date(s.ts);
    // ISO week key: YYYY-Wnn (simplified; week-of-year suffices for retention).
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const wk = Math.floor((d.getTime() - yearStart.getTime()) / (7 * 86400000));
    const wkKey = `${d.getUTCFullYear()}-W${wk}`;
    if (seenWeek.has(wkKey)) continue;
    if (seenWeek.size >= keepWeekly) break;
    seenWeek.add(wkKey);
    keep.add(s.name);
  }

  const pruned = [];
  for (const s of snaps) {
    if (keep.has(s.name)) continue;
    try { fs.unlinkSync(s.file); pruned.push(s.name); } catch (_) {}
  }
  return { ok: true, kept: Array.from(keep), pruned };
}

module.exports = {
  snapshotVault,
  listSnapshots,
  restoreSnapshot,
  pruneSnapshots,
};
