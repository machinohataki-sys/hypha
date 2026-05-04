'use strict';

// Vault adapter — resolves the user's vault root, scans for .md notes,
// extracts phase from frontmatter and time-since from mtime.
//
// Phase mapping (PTOR -> design):
//   no phase / 0 -> 0 (untouched)
//   1            -> 1
//   2            -> 2
//   3, 4         -> 3 (P3+P4 merged)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function resolveRoot() {
  // Hypha override: HYPHA_DATA wins, then default to hypha/data (one level up
  // from app/lib/vault.js → hypha/app → hypha → data).
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  const hyphaDefault = path.resolve(__dirname, '..', '..', 'data');
  if (process.env.PTOR_VAULT && fs.existsSync(process.env.PTOR_VAULT)) {
    return process.env.PTOR_VAULT;
  }
  return hyphaDefault;
}

function ensureRoot() {
  const root = resolveRoot();
  if (!fs.existsSync(root)) {
    try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
  }
  return root;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

function clampPhase(p) {
  if (typeof p === 'string') p = parseInt(p, 10);
  if (!Number.isFinite(p)) return 0;
  if (p >= 3) return 3;
  if (p >= 1) return p;
  return 0;
}

function timeSince(when) {
  const ms = Date.now() - new Date(when).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return '·';
  const min = ms / 60000;
  if (min < 1) return 'now';
  if (min < 60) return `${Math.floor(min)}m`;
  const h = min / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d`;
  const mo = d / 30;
  if (mo < 12) return `${Math.floor(mo)}mo`;
  return `${Math.floor(mo / 12)}y`;
}

function safeReadText(abs) {
  try { return fs.readFileSync(abs, 'utf-8'); } catch (_) { return ''; }
}

// List top-level folders in vault. Each folder yields { folder, count, items }.
// Hidden dirs (starting with .) are skipped — vc-core meta lives in .beiking/.
function list() {
  const root = ensureRoot();
  let dirents;
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return { root, folders: [] };
  }

  const folders = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith('.')) continue;
    const sub = path.join(root, d.name);
    let entries = [];
    try {
      entries = fs.readdirSync(sub, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'));
    } catch (_) { entries = []; }
    // v0.6.7 — hide chain meta-folders. A folder containing chain.json + zero
    // .md files is the meta directory holding chain.json/covenant.json/links-
    // state.json — not a curriculum. Showing it as an empty 0-node folder
    // confused users (who expected a course there). Surface the chain via the
    // first link's curriculum + the chain banner in NoteView instead.
    if (entries.length === 0) {
      try {
        const chainPath = path.join(sub, 'chain.json');
        if (fs.existsSync(chainPath)) {
          const chainData = JSON.parse(fs.readFileSync(chainPath, 'utf8'));
          if (chainData && (chainData.is_chain_meta === true || chainData.chain || chainData.ultimate_goal)) {
            continue;  // skip rendering this chain-meta folder
          }
        }
      } catch (_) {}
    }

    const items = entries.map(e => {
      const full = path.join(sub, e.name);
      let stat = null;
      try { stat = fs.statSync(full); } catch (_) {}
      const text = safeReadText(full);
      const fm = parseFrontmatter(text);
      const phase = clampPhase(fm.phase);
      // Hypha extension — surface lesson_idx + locked + learn_goal so VaultTree
      // can sort & lock-visualize without re-reading each .md.
      const lessonIdx = (fm.lesson_idx !== undefined && fm.lesson_idx !== '')
        ? parseInt(fm.lesson_idx, 10) : null;
      const locked = String(fm.locked || '').toLowerCase() === 'true';
      const learnGoal = fm.learn_goal ? String(fm.learn_goal).replace(/^"|"$/g, '') : '';
      // 2026-05-01 RECALL filter: surface date_distilled so RecallDashboard
      // can hide live curriculum stubs (lessonIdx + !distilled) but keep
      // finished/graduated lesson notes (lessonIdx + distilled) in the queue.
      const distilled = !!(fm.date_distilled && String(fm.date_distilled).trim());
      // Phase 3.1 — `adapted: true` is written to lesson frontmatter when
      // adaptLessonGoal mutates a downstream lesson. VaultTree shows a quiet
      // italic mark on adapted items.
      const adapted = String(fm.adapted || '').toLowerCase() === 'true';
      // v0.4.0 — `ghost: true` flags pending lessons that haven't materialized
      // yet (body == '_pending_'). VaultTree renders them as italic dimmed
      // rows with a "(pending)" suffix; click is disabled.
      const ghost = String(fm.ghost || '').toLowerCase() === 'true';
      const phaseLabel = String(fm.phase_label || '').replace(/^"|"$/g, '');
      const phaseId = String(fm.phase_id || '');
      // v0.10.1 — capture date_created so chain folders can be sorted by
      // creation order (chronological) instead of alphabetic by chainSlug.
      // User reported newer chains rendering above older ones because pinyin
      // slug compare put "yi-..." before "yong-...".
      const dateCreated = (fm.date_created && String(fm.date_created).trim() && fm.date_created !== 'null')
        ? String(fm.date_created).trim().replace(/^"|"$/g, '')
        : null;
      return {
        id: `${d.name}/${e.name}`,
        rel: `${d.name}/${e.name}`,
        label: e.name,
        phase,
        since: stat ? timeSince(stat.mtime) : '·',
        mtime: stat ? stat.mtime.toISOString() : null,
        lessonIdx: Number.isFinite(lessonIdx) ? lessonIdx : null,
        locked,
        learnGoal,
        distilled,
        adapted,
        ghost,
        phaseLabel,
        phaseId,
        dateCreated,
      };
    });

    // Hypha — if any item has lessonIdx, this folder is a curriculum; sort by lessonIdx.
    // Otherwise fall back to mtime-descending (PTOR2 default).
    const hasLessons = items.some(it => it.lessonIdx !== null);
    if (hasLessons) {
      items.sort((a, b) => {
        const ai = a.lessonIdx ?? 9999;
        const bi = b.lessonIdx ?? 9999;
        if (ai !== bi) return ai - bi;
        return a.label.localeCompare(b.label);
      });
    } else {
      items.sort((a, b) => {
        if (a.mtime && b.mtime) return b.mtime.localeCompare(a.mtime);
        return a.label.localeCompare(b.label);
      });
    }

    // v0.6.8 — surface chain metadata per folder so VaultTree can group + sort
    // chain links by their position in the chain. state.json is read once here
    // (cached by fs cache) so renderer doesn't have to re-fetch per folder.
    let chainSlug = null;
    let chainLinkIdx = null;
    let chainUltimateGoal = null;
    let chainTotalLinks = null;
    let chainPlaceholder = false;
    try {
      const statePath = path.join(sub, 'state.json');
      if (fs.existsSync(statePath)) {
        const stateText = fs.readFileSync(statePath, 'utf8');
        const state = JSON.parse(stateText);
        if (state && state.chainSlug) {
          chainSlug = state.chainSlug;
          chainLinkIdx = (typeof state.chainLinkIdx === 'number') ? state.chainLinkIdx : null;
          chainUltimateGoal = state.chainUltimateGoal || null;
          chainTotalLinks = (typeof state.chainTotalLinks === 'number') ? state.chainTotalLinks : null;
          chainPlaceholder = state.chainPlaceholder === true;
        }
      }
    } catch (_) {}

    // v0.10.1 — folder's earliest date_created across its items (used for
    // chain-vs-chain chronological sort below). Falls through to null if no
    // item has the field; sort then degrades to alphabetic chainSlug.
    const itemDates = items.map(it => it.dateCreated).filter(Boolean).sort();
    const folderDateCreated = itemDates[0] || null;

    // v0.11.x — earliest item mtime as full-ISO ms-precision creation signal.
    // frontmatter date_created is YYYY-MM-DD only; two chains created on the
    // same day collide and force the comparator to fall back to alphabetic
    // chainSlug (wrong order, e.g. "yi-..." sorts above "yong-..." even
    // though the "yong-..." chain was generated first).
    const itemMtimes = items.map(it => it.mtime).filter(Boolean).sort();
    const folderEarliestMtime = itemMtimes[0] || null;

    folders.push({
      folder: d.name,
      count: items.length,
      items,
      chainSlug,
      chainLinkIdx,
      chainUltimateGoal,
      chainTotalLinks,
      chainPlaceholder,
      dateCreated: folderDateCreated,
      earliestMtime: folderEarliestMtime,
    });
  }

  // v0.11.x — pre-pass: per-chain earliest "creation signal" across ALL its
  // folders. Prefer earliestMtime (full ISO with ms) over dateCreated
  // (YYYY-MM-DD) so same-day chain creation orders deterministically by
  // generation time. Falls back to dateCreated only when mtime is missing
  // (legacy data).
  const chainEarliestSignal = new Map();
  for (const f of folders) {
    if (!f.chainSlug) continue;
    const sig = f.earliestMtime || f.dateCreated;
    if (!sig) continue;
    const cur = chainEarliestSignal.get(f.chainSlug);
    if (!cur || sig < cur) chainEarliestSignal.set(f.chainSlug, sig);
  }

  // v0.6.8 — chain-aware folder ordering. Chain links sort by chainLinkIdx
  // within their group (so paul-graham link 1 comes before altman link 2).
  // VaultTree renders chain folders nested under a virtual parent header, but
  // the underlying order here keeps them adjacent for that grouping to work.
  folders.sort((a, b) => {
    // Chain folders grouped together by chainSlug; non-chain folders alphabetical.
    const aChain = a.chainSlug || '';
    const bChain = b.chainSlug || '';
    if (aChain && bChain) {
      if (aChain !== bChain) {
        // chain-vs-chain: compare by earliest mtime/dateCreated signal;
        // tie-break alphabetic for determinism.
        const aSig = chainEarliestSignal.get(aChain) || '';
        const bSig = chainEarliestSignal.get(bChain) || '';
        if (aSig && bSig && aSig !== bSig) return aSig.localeCompare(bSig);
        return aChain.localeCompare(bChain);
      }
      return (a.chainLinkIdx ?? 9999) - (b.chainLinkIdx ?? 9999);
    }
    if (aChain && !bChain) return 1;   // chain folders sink to bottom of list
    if (!aChain && bChain) return -1;  // non-chain folders rise to top
    return a.folder.localeCompare(b.folder);
  });
  return { root, folders };
}

function read(rel) {
  const root = ensureRoot();
  const safe = path.normalize(rel).replace(/^[\\/]+/, '');
  const abs = path.resolve(root, safe);
  if (!abs.startsWith(path.resolve(root))) throw new Error('path escapes vault');
  if (!fs.existsSync(abs)) return null;
  const text = safeReadText(abs);
  const stat = fs.statSync(abs);
  return {
    rel: safe.replace(/\\/g, '/'),
    body: text,
    frontmatter: parseFrontmatter(text),
    mtime: stat.mtime.toISOString(),
    size: stat.size,
  };
}

function write(rel, body) {
  const root = ensureRoot();
  const safe = path.normalize(rel).replace(/^[\\/]+/, '');
  const abs = path.resolve(root, safe);
  if (!abs.startsWith(path.resolve(root))) throw new Error('path escapes vault');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf-8');
  const stat = fs.statSync(abs);
  _backlinksCacheClear();   // body change can affect any backlink — clear all
  return { rel: safe.replace(/\\/g, '/'), mtime: stat.mtime.toISOString(), size: stat.size };
}

function safeAbs(rel) {
  const root = ensureRoot();
  const safe = path.normalize(rel).replace(/^[\\/]+/, '');
  const abs = path.resolve(root, safe);
  if (!abs.startsWith(path.resolve(root))) throw new Error('path escapes vault');
  return { root, safe, abs };
}

// Delete a note (file) OR a folder. 2026-05-02 — refactored to SOFT-DELETE:
// moves the target to vault/.trash/<basename>-<unixMs>/ instead of unlink.
// purgeStaleTrash() (called on app startup + per vault:list when free) hard-
// purges trash entries older than 7 days. restoreFromTrash() can recover
// within that window. The .trash dir is hidden from vault.list (skipped by
// dotfile filter at the top of list()). On any error during the move (cross-
// device, permissions, ENOSPC), falls back to legacy hard delete so the UI
// promise still resolves.
function del(rel) {
  const { abs, root, safe } = safeAbs(rel);
  if (!fs.existsSync(abs)) return { ok: false, reason: 'not found', rel: safe.replace(/\\/g, '/') };
  try {
    const trashDir = path.join(root, '.trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const baseName = path.basename(abs);
    const ts = Date.now();
    const trashTarget = path.join(trashDir, `${baseName}-${ts}`);
    fs.renameSync(abs, trashTarget);
    _backlinksCacheClear();
    return { ok: true, rel: safe.replace(/\\/g, '/'), trashedAs: path.basename(trashTarget) };
  } catch (_) {
    // Fallback to hard delete if soft-delete fails (cross-device rename, perms)
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      else fs.unlinkSync(abs);
    } catch (_) {}
    _backlinksCacheClear();
    return { ok: true, rel: safe.replace(/\\/g, '/'), trashedAs: null };
  }
}

// purgeStaleTrash — hard-delete .trash entries older than maxAgeMs (default 7d).
// Idempotent + silent on errors. Called on Hypha startup + opportunistically.
function purgeStaleTrash(maxAgeMs) {
  const root = ensureRoot();
  const trashDir = path.join(root, '.trash');
  if (!fs.existsSync(trashDir)) return { purged: 0 };
  const cutoff = Date.now() - (typeof maxAgeMs === 'number' ? maxAgeMs : 7 * 24 * 3600 * 1000);
  let purged = 0;
  try {
    const entries = fs.readdirSync(trashDir, { withFileTypes: true });
    for (const e of entries) {
      const m = e.name.match(/-(\d+)$/);
      if (!m) continue;
      const ts = Number(m[1]);
      if (!Number.isFinite(ts) || ts > cutoff) continue;
      const p = path.join(trashDir, e.name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
        else fs.unlinkSync(p);
        purged++;
      } catch (_) {}
    }
  } catch (_) {}
  return { purged };
}

// restoreFromTrash — move .trash/<trashName> back to original vault root
// position (strip trailing -<ts>). Refuses if target name already exists.
function restoreFromTrash(trashName) {
  const root = ensureRoot();
  const trashAbs = path.join(root, '.trash', trashName);
  if (!fs.existsSync(trashAbs)) return { ok: false, reason: 'not found in trash' };
  const m = trashName.match(/^(.+?)-\d+$/);
  const originalName = m ? m[1] : trashName;
  const targetAbs = path.join(root, originalName);
  if (fs.existsSync(targetAbs)) return { ok: false, reason: 'target already exists' };
  fs.renameSync(trashAbs, targetAbs);
  _backlinksCacheClear();
  return { ok: true, rel: originalName };
}

// Rename / move a file or folder. Both rels are vault-relative.
// If newRel's parent doesn't exist, create it. Refuses if newRel already exists.
function rename(oldRel, newRel) {
  const a = safeAbs(oldRel);
  const b = safeAbs(newRel);
  if (!fs.existsSync(a.abs)) throw new Error('source not found');
  if (fs.existsSync(b.abs)) throw new Error('target already exists');
  fs.mkdirSync(path.dirname(b.abs), { recursive: true });
  fs.renameSync(a.abs, b.abs);
  _backlinksCacheClear();   // rename invalidates everything
  return { ok: true, rel: b.safe.replace(/\\/g, '/') };
}

// Create an empty folder (mkdir -p). Idempotent — returns ok if already exists.
function mkdir(rel) {
  const { abs, safe } = safeAbs(rel);
  fs.mkdirSync(abs, { recursive: true });
  return { ok: true, rel: safe.replace(/\\/g, '/') };
}

// Global backlinks reverse-index — built once, O(1) lookups thereafter.
// Per user 2026-04-29 V3.7 卡顿持续: per-rel cache 仍 cold-path 全 vault scan
// 每个新 note. 全局反向索引一次扫完整个 vault, 反转成 Map<targetBaseLower,
// Array<{rel, label, excerpt}>>, 任何 rel 查询 O(1).
//
// Cost: 1 次 walk + read 每个 .md (~50-200ms for typical vault). Memory:
// 几 KB per backlink edge (excerpt 80 chars max).
//
// 失效策略: write/del/rename 任何 vault 变动 → 全 index 清空, 下次 backlinks
// 调用触发 rebuild.
let _backlinksIndex = null;             // Map<targetBaseLower, [{rel, label, excerpt}]>
let _backlinksIndexBuiltAt = 0;
const BACKLINKS_INDEX_TTL = 5 * 60_000; // 5min safety TTL even without writes

function _buildBacklinksIndex() {
  const root = ensureRoot();
  const linkRegex = /\[\[([^\]|\n]+?)(?:\|[^\]\n]+?)?\]\]/g;
  const index = new Map();

  function walk(dir, prefix) {
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      const sub = path.join(dir, d.name);
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) walk(sub, rel);
      else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) {
        const text = safeReadText(sub);
        if (!text || !text.includes('[[')) continue;
        const sourceLabel = d.name.replace(/\.md$/i, '');
        const sourceRel = rel.replace(/\\/g, '/');
        linkRegex.lastIndex = 0;
        const seenInSource = new Set();
        let m;
        while ((m = linkRegex.exec(text)) !== null) {
          const target = (m[1] || '').trim().toLowerCase();
          if (!target || seenInSource.has(target)) continue;
          seenInSource.add(target);
          const idx = m.index;
          const start = Math.max(0, idx - 40);
          const end = Math.min(text.length, idx + m[0].length + 40);
          const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();
          if (!index.has(target)) index.set(target, []);
          index.get(target).push({ rel: sourceRel, label: sourceLabel, excerpt });
        }
      }
    }
  }
  walk(root, '');
  _backlinksIndex = index;
  _backlinksIndexBuiltAt = Date.now();
}

function _backlinksCacheClear() {
  _backlinksIndex = null;
}

// backlinks(targetRel) — scan vault for [[wikilink]] references TO this note.
// Matches by basename (Obsidian convention: filename without .md, case-
// insensitive). Returns [{ rel, excerpt }] where excerpt = ±40 chars around
// the link. v0.1: linear scan, no cache. Acceptable for vaults < 500 notes.
//
// Per user 2026-04-29: 把 Obsidian 的灵魂融入 PTOR — [[wikilink]] +
// bidirectional links 是 vault 的真正互联机制.
function backlinks(targetRel) {
  if (!targetRel) return [];
  // Build / rebuild global index lazily
  if (!_backlinksIndex || (Date.now() - _backlinksIndexBuiltAt > BACKLINKS_INDEX_TTL)) {
    _buildBacklinksIndex();
  }
  if (!_backlinksIndex) return [];
  const targetBase = path.basename(targetRel, path.extname(targetRel)).toLowerCase();
  const targetRelNoExt = targetRel.replace(/\.md$/i, '').toLowerCase();
  // Lookup by both basename and full rel-without-ext (Obsidian conv)
  const fromBase = _backlinksIndex.get(targetBase) || [];
  const fromRel = (targetRelNoExt !== targetBase) ? (_backlinksIndex.get(targetRelNoExt) || []) : [];
  const seen = new Set();
  const out = [];
  for (const r of [...fromBase, ...fromRel]) {
    if (r.rel === targetRel) continue;
    if (seen.has(r.rel)) continue;
    seen.add(r.rel);
    out.push(r);
    if (out.length >= 50) break;
  }
  return out;
}

// Hypha extensions — JSON / JSONL helpers + listDir + exists for curriculum data.
function readJSON(rel, fallback = null) {
  const r = read(rel);
  if (!r) return fallback;
  try { return JSON.parse(r.body); } catch (_) { return fallback; }
}
function writeJSON(rel, obj) { return write(rel, JSON.stringify(obj, null, 2)); }
function appendJSONL(rel, obj) {
  const { abs } = safeAbs(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(obj) + '\n', 'utf-8');
}
function readJSONL(rel) {
  const r = read(rel);
  if (!r) return [];
  return r.body.split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}
function listDir(rel) {
  try {
    const { abs } = safeAbs(rel || '.');
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter(d => !d.name.startsWith('.'))
      .map(d => ({ name: d.name, isDir: d.isDirectory() }));
  } catch (_) { return []; }
}
function exists(rel) {
  try { const { abs } = safeAbs(rel); return fs.existsSync(abs); }
  catch (_) { return false; }
}

module.exports = {
  resolveRoot, list, read, write, del, rename, mkdir, backlinks,
  readJSON, writeJSON, appendJSONL, readJSONL, listDir, exists,
  purgeStaleTrash, restoreFromTrash,
};
