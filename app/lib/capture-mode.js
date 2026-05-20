'use strict';

// HYPHA · W1.5 Capture Mode (v0.1).
//
// Live capture surface for real-world classroom / video lecture / longform
// reading. Per BLUEPRINT §9.2 the original Hypha default mode during real
// learning is *capture*, not deepen — the user only records lightly while
// the lesson is live, and switches to the Finish Ritual after.
//
// Storage model: each session = one folder under `vault/_captures/<sessionId>/`.
// Raw events stream into `raw.jsonl` (append-only, one JSON object per line)
// so we never lose data on crash. The Finish Ritual (finish-ritual.js) reads
// raw.jsonl, aggregates similar marks, parallel-deepens each, and finally
// hands the consolidated payload to lesson-note.depositLessonNote.
//
// Allowed entry types — kept deliberately small per the "低打扰" principle:
//   quick_note   : plain typed line, no mark_type
//   mark         : a typed line tagged with one of the 8 mark types (§9.3)
//   deepen_now   : a 30s short-answer when user is stuck mid-lesson
//
// The 8 mark types (per BLUEPRINT §9.3, identical Unicode glyphs as the UI):
//   ? 不懂 · ! 重要 · ↗ 深化 · ⚡ Spark · × 反驳 · → 行动 · 🔗 连接旧知识 · 🧩 迁移
//
// We do NOT expose edit / delete on a live session — Capture Mode is write-
// only at the data layer. The Finish Ritual is where merging / pruning
// happens, after the user has decompressed from the lesson.

const fs = require('fs');
const path = require('path');

const VAULT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..', 'vault');

function vaultRoot() {
  return process.env.HYPHA_VAULT_ROOT || VAULT_ROOT_DEFAULT;
}

const ALLOWED_SOURCES = new Set(['lecture', 'video', 'reading']);
const ALLOWED_ENTRY_TYPES = new Set(['quick_note', 'mark', 'deepen_now']);

// 8 mark glyphs per §9.3 — single-codepoint Unicode (incl. emoji compounds).
// Kept as a Set rather than enum so the UI can ship the same string back
// without translation overhead.
const ALLOWED_MARK_TYPES = new Set([
  '?',     // 不懂   — confusion / question
  '!',     // 重要   — emphasis / "this matters"
  '↗',    // 深化   — wants follow-up deepen
  '⚡',   // Spark — cross-connection ignition
  '×',    // 反驳   — contradiction / pushback
  '→',    // 行动   — action item / commit-to-do
  '🔗',   // 连接   — links to prior knowledge
  '🧩',   // 迁移   — transfer candidate → product / artifact
]);

// Sessions are timestamp+random to keep them sortable + collision-resistant
// without needing a uuid dep. `cap-<unixms>-<6char>`.
function newSessionId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `cap-${ts}-${rand}`;
}

function sessionDir(sessionId) {
  if (!sessionId || typeof sessionId !== 'string' || !/^cap-[0-9a-z-]+$/i.test(sessionId)) {
    throw Object.assign(new Error('invalid sessionId'), { code: 'BAD_INPUT' });
  }
  return path.join(vaultRoot(), '_captures', sessionId);
}

function manifestPath(sessionId) {
  return path.join(sessionDir(sessionId), 'manifest.json');
}

function rawPath(sessionId) {
  return path.join(sessionDir(sessionId), 'raw.jsonl');
}

function readManifest(sessionId) {
  const p = manifestPath(sessionId);
  if (!fs.existsSync(p)) {
    throw Object.assign(new Error('session not found'), { code: 'NOT_FOUND' });
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw Object.assign(new Error('manifest unreadable: ' + err.message), { code: 'CORRUPT' });
  }
}

function writeManifest(sessionId, manifest) {
  fs.writeFileSync(manifestPath(sessionId), JSON.stringify(manifest, null, 2), 'utf8');
}

// createCaptureSession({ source, context }) → { sessionId, startedAt, vault_path }
//
// `context` is opaque caller-supplied JSON (e.g. { lecture_title, course_slug,
// instructor }) — persisted in manifest.json for Finish Ritual rendering but
// never enforced schema-wise. Surgical: we don't dictate UX vocabulary here.
function createCaptureSession({ source, context } = {}) {
  if (!ALLOWED_SOURCES.has(source)) {
    throw Object.assign(new Error(`source must be one of ${[...ALLOWED_SOURCES].join('|')}`), { code: 'BAD_INPUT' });
  }
  const sessionId = newSessionId();
  const startedAt = new Date().toISOString();
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    sessionId,
    source,
    context: (context && typeof context === 'object') ? context : {},
    startedAt,
    closedAt: null,
    entryCount: 0,
    schema_version: 'capture-v1',
  };
  writeManifest(sessionId, manifest);
  // Touch raw.jsonl so append never has to mkdir on first entry.
  fs.writeFileSync(rawPath(sessionId), '', { flag: 'a' });
  return {
    sessionId,
    startedAt,
    vault_path: `vault/_captures/${sessionId}/`,
  };
}

// appendCapture(sessionId, { type, mark_type?, text, timestamp_offset_ms })
// → { ok, seq, total }
//
// Append-only. Each entry gets a monotonic `seq` (1-based) and an absolute
// `wrote_at` timestamp on top of the caller-supplied `timestamp_offset_ms`
// (which is the offset from session start as known by the UI clock).
function appendCapture(sessionId, entry = {}) {
  const manifest = readManifest(sessionId);
  if (manifest.closedAt) {
    throw Object.assign(new Error('session is closed'), { code: 'CLOSED' });
  }
  const { type, mark_type, text, timestamp_offset_ms } = entry;
  if (!ALLOWED_ENTRY_TYPES.has(type)) {
    throw Object.assign(new Error(`type must be one of ${[...ALLOWED_ENTRY_TYPES].join('|')}`), { code: 'BAD_INPUT' });
  }
  if (type === 'mark' && !ALLOWED_MARK_TYPES.has(mark_type)) {
    throw Object.assign(new Error('mark entries require a recognized mark_type glyph'), { code: 'BAD_INPUT' });
  }
  if (typeof text !== 'string') {
    throw Object.assign(new Error('text must be a string (use "" for empty marks)'), { code: 'BAD_INPUT' });
  }
  // Cap individual entry size — live capture should never be longform.
  if (text.length > 4000) {
    throw Object.assign(new Error('text exceeds 4000 chars; longform belongs in Finish Ritual deepen'), { code: 'TOO_LARGE' });
  }
  const seq = (manifest.entryCount || 0) + 1;
  const wroteAt = new Date().toISOString();
  const row = {
    seq,
    type,
    mark_type: type === 'mark' ? mark_type : null,
    text,
    timestamp_offset_ms: Number.isFinite(timestamp_offset_ms) ? Math.floor(timestamp_offset_ms) : 0,
    wrote_at: wroteAt,
  };
  // Append + fsync semantics: appendFileSync is the closest portable thing
  // we have on Node without going to fs.openSync + fsync. Capture data is
  // the load-bearing artifact; we accept the slight cost.
  fs.appendFileSync(rawPath(sessionId), JSON.stringify(row) + '\n', 'utf8');
  manifest.entryCount = seq;
  writeManifest(sessionId, manifest);
  return { ok: true, seq, total: seq };
}

// closeCaptureSession(sessionId) → { ok, sessionId, entryCount, durationMs }
//
// Idempotent — closing an already-closed session returns the existing
// closedAt without erroring (so the UI can fire it twice without a guard).
function closeCaptureSession(sessionId) {
  const manifest = readManifest(sessionId);
  if (!manifest.closedAt) {
    manifest.closedAt = new Date().toISOString();
    writeManifest(sessionId, manifest);
  }
  const durationMs = Date.parse(manifest.closedAt) - Date.parse(manifest.startedAt);
  return {
    ok: true,
    sessionId,
    entryCount: manifest.entryCount || 0,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    closedAt: manifest.closedAt,
    vault_path: `vault/_captures/${sessionId}/`,
  };
}

// readSession(sessionId) — used by Finish Ritual to load + iterate the raw
// stream. Returns { manifest, entries:[…] } in seq order.
function readSession(sessionId) {
  const manifest = readManifest(sessionId);
  const p = rawPath(sessionId);
  if (!fs.existsSync(p)) return { manifest, entries: [] };
  const txt = fs.readFileSync(p, 'utf8');
  const lines = txt.split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const ln of lines) {
    try {
      entries.push(JSON.parse(ln));
    } catch (_) {
      // Skip corrupt lines silently; in production we'd want a recovery log,
      // but for a partially-failed JSONL stream the load-bearing answer is
      // "preserve the rest of the data, don't throw the session away."
    }
  }
  entries.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return { manifest, entries };
}

module.exports = {
  createCaptureSession,
  appendCapture,
  closeCaptureSession,
  readSession,
  // Surface the constant sets so finish-ritual.js + UI can share the truth
  // without hard-coding magic glyphs in three places.
  ALLOWED_SOURCES,
  ALLOWED_ENTRY_TYPES,
  ALLOWED_MARK_TYPES,
};
