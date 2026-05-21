'use strict';
// HYPHA Wave 1.4 — Misconception Vault (sidecar persistence).
//
// Stores classified misconception records OUTSIDE the 11-field lesson body
// schema so future schema migrations don't have to carry W1.4 data, and so
// cross-lesson reads don't have to parse full lesson body.json files.
//
// Layout (relative to vault root resolved by lib/vault.js):
//   <slug>/lesson-<idx>/misconceptions/kp-<id>.json
//   <slug>/lesson-<idx>/misconceptions/_lesson.json   (lesson-level aggregate,
//                                                     written on first KP write)
//
// File schema (kp-<id>.json):
//   {
//     slug, lessonIdx, kpId, misconceptions: [<record>, ...],
//     updatedAt, schemaVersion: 'w14.v0'
//   }
//
// Each <record> = output of misconception-engine.extractMisconceptions(),
// plus optional `triggeredAt` + `repairedAt` timestamps appended by W1.3
// Anti-Illusion when a runtime detection fires.
//
// Pure fs + path — no Electron API. The lesson generation pipeline calls
// this from main.js (renderer-isolated), but a CLI test harness or
// crossLessonMisconceptionsForTopic harvester can call it directly.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 'w14.v0';

// Mirror vault.js root resolution so this lib can be tested standalone
// (mkdtemp + write + read) without booting Electron. HYPHA_DATA env var wins;
// PTOR_VAULT is honored for back-compat; default is hypha/data.
function _resolveVaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.PTOR_VAULT && fs.existsSync(process.env.PTOR_VAULT)) {
    return process.env.PTOR_VAULT;
  }
  // app/lib/misconception-vault.js → app/lib → app → hypha → data
  return path.resolve(__dirname, '..', '..', 'data');
}

function _sidecarDir(root, slug, lessonIdx) {
  return path.join(root, slug, `lesson-${lessonIdx}`, 'misconceptions');
}

function _sidecarPath(root, slug, lessonIdx, kpId) {
  const safeId = String(kpId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(_sidecarDir(root, slug, lessonIdx), `kp-${safeId}.json`);
}

function _isValidArgs(slug, lessonIdx) {
  return typeof slug === 'string' && slug.length > 0 &&
    Number.isFinite(lessonIdx) && lessonIdx >= 0;
}

// ---------------------------------------------------------------------------
// writeMisconception: write/merge a single KP's misconception record(s) into
// the sidecar. Accepts either a single record (object) or an array of
// records. Existing records with the same `id` are replaced; new records are
// appended. Returns { ok, path, count } or { ok:false, error }.
// ---------------------------------------------------------------------------
function writeMisconception(slug, lessonIdx, kpId, misconception) {
  if (!_isValidArgs(slug, lessonIdx)) {
    return { ok: false, error: 'BAD_ARGS', message: 'slug + lessonIdx required' };
  }
  if (!kpId) return { ok: false, error: 'BAD_ARGS', message: 'kpId required' };
  if (!misconception) return { ok: false, error: 'BAD_ARGS', message: 'misconception required' };

  const root = _resolveVaultRoot();
  const dir = _sidecarDir(root, slug, lessonIdx);
  const file = _sidecarPath(root, slug, lessonIdx, kpId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, error: 'MKDIR_FAILED', message: err.message };
  }

  // Read existing payload (if any) and merge by record.id (or text fallback).
  let existing = null;
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { existing = null; }
  }
  const prior = (existing && Array.isArray(existing.misconceptions)) ? existing.misconceptions : [];

  const incoming = Array.isArray(misconception) ? misconception : [misconception];
  const byKey = new Map();
  for (const m of prior) {
    const k = m && (m.id || m.text);
    if (k) byKey.set(k, m);
  }
  for (const m of incoming) {
    const k = m && (m.id || m.text);
    if (!k) continue;
    // Preserve any runtime-appended timestamps from prior record when merging
    // a freshly-extracted record (e.g. re-extract after lesson body regen
    // shouldn't wipe `triggeredAt` history).
    const prev = byKey.get(k);
    const merged = prev
      ? { ...m, triggeredAt: prev.triggeredAt || m.triggeredAt, repairedAt: prev.repairedAt || m.repairedAt }
      : m;
    byKey.set(k, merged);
  }
  const merged = Array.from(byKey.values());

  const payload = {
    slug,
    lessonIdx,
    kpId,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    misconceptions: merged,
  };
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (err) {
    return { ok: false, error: 'WRITE_FAILED', message: err.message };
  }
  return { ok: true, path: file, count: merged.length };
}

// ---------------------------------------------------------------------------
// readMisconceptions: read sidecar(s). If kpId given, returns that KP's
// records only. Without kpId, reads every kp-*.json under the lesson dir and
// returns a flat array. Returns [] on miss (never throws).
// ---------------------------------------------------------------------------
function readMisconceptions(slug, lessonIdx, kpId) {
  if (!_isValidArgs(slug, lessonIdx)) return [];
  const root = _resolveVaultRoot();
  if (kpId) {
    const file = _sidecarPath(root, slug, lessonIdx, kpId);
    if (!fs.existsSync(file)) return [];
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(payload.misconceptions) ? payload.misconceptions : [];
    } catch (_) { return []; }
  }
  const dir = _sidecarDir(root, slug, lessonIdx);
  if (!fs.existsSync(dir)) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!name.startsWith('kp-') || !name.endsWith('.json')) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
      if (Array.isArray(payload.misconceptions)) {
        for (const m of payload.misconceptions) out.push(m);
      }
    } catch (_) { /* skip malformed sidecar */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// crossLessonMisconceptionsForTopic: scan every slug under the vault root,
// find lessons where the slug or state.json's title/topic overlaps with the
// requested topic, return their misconception records. Used by agent.js
// _buildLessonBriefBlock to pre-load wrong-priors learned in prior courses
// of the same subject (e.g. user took "philosophy-of-mind" + now starts
// "consciousness-studies" — surface the same dualism trap).
//
// Returns [] when vault is empty or no slug matches. Cap at MAX_RECORDS to
// keep the LESSON BRIEF token budget bounded (per CLAUDE.md surgical rule).
// ---------------------------------------------------------------------------
const MAX_CROSS_LESSON_RECORDS = 12;

function _normalizeTopic(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-]+/g, '-').replace(/[^a-z0-9一-鿿-]/g, '');
}

function _slugMatchesTopic(slug, topic) {
  const a = _normalizeTopic(slug);
  const b = _normalizeTopic(topic);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Token overlap: at least one ≥3-char token shared.
  const ta = new Set(a.split('-').filter(t => t.length >= 3));
  const tb = new Set(b.split('-').filter(t => t.length >= 3));
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

function _readStateTopicAliases(root, slug) {
  // state.json carries the human-readable topic + lessonPlan titles. Use
  // those as secondary match-keys so e.g. slug "phil-of-mind-2026-05-13"
  // still matches topic "philosophy of mind".
  const file = path.join(root, slug, 'state.json');
  if (!fs.existsSync(file)) return [];
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const aliases = [];
    if (s.topic) aliases.push(String(s.topic));
    if (s.title) aliases.push(String(s.title));
    if (Array.isArray(s.lessonPlan)) {
      for (const l of s.lessonPlan.slice(0, 3)) {
        if (l && l.title) aliases.push(String(l.title));
      }
    }
    return aliases;
  } catch (_) { return []; }
}

function crossLessonMisconceptionsForTopic(topic) {
  const t = String(topic || '').trim();
  if (!t) return [];
  const root = _resolveVaultRoot();
  if (!fs.existsSync(root)) return [];
  let slugs;
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name);
  } catch (_) { return []; }

  const matchingSlugs = slugs.filter(slug => {
    if (_slugMatchesTopic(slug, t)) return true;
    const aliases = _readStateTopicAliases(root, slug);
    return aliases.some(a => _slugMatchesTopic(a, t) || _slugMatchesTopic(t, a));
  });

  const out = [];
  for (const slug of matchingSlugs) {
    // Walk every lesson-N/misconceptions/ dir under the slug. lesson indices
    // are not contiguous (deletions / partial generation), so enumerate by
    // directory scan rather than 0..N range.
    const slugDir = path.join(root, slug);
    let lessonDirs;
    try {
      lessonDirs = fs.readdirSync(slugDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && /^lesson-\d+$/.test(d.name))
        .map(d => d.name);
    } catch (_) { continue; }
    for (const ld of lessonDirs) {
      const m = ld.match(/^lesson-(\d+)$/);
      if (!m) continue;
      const idx = Number(m[1]);
      const records = readMisconceptions(slug, idx);
      for (const rec of records) {
        out.push({ ...rec, _sourceSlug: slug, _sourceLessonIdx: idx });
        if (out.length >= MAX_CROSS_LESSON_RECORDS) return out;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// dedupeMisconceptions: merge cross-lesson records with the current lesson's
// own records, dedupe by lowercase text prefix, preserve severity priority
// (critical > high > medium > low). Used by agent.js _buildLessonBriefBlock.
// ---------------------------------------------------------------------------
const _SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

function dedupeMisconceptions(...lists) {
  const byKey = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || !m.text) continue;
      const key = String(m.text).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, m); continue; }
      const prevRank = _SEVERITY_RANK[prev.severity] || 0;
      const curRank = _SEVERITY_RANK[m.severity] || 0;
      if (curRank > prevRank) byKey.set(key, m);
    }
  }
  return Array.from(byKey.values());
}

module.exports = {
  writeMisconception,
  readMisconceptions,
  crossLessonMisconceptionsForTopic,
  dedupeMisconceptions,
  SCHEMA_VERSION,
  // Exposed for tests so they can override the vault root via env without
  // monkeypatching internals.
  _resolveVaultRoot,
};
