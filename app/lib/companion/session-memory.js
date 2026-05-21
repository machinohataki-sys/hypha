'use strict';
// HYPHA · Companion Multi-Session Memory — AMD-MEOW-P8 B4 (2026-05-21).
//
// Closes Companion System gap "multi-session memory continuity" listed in
// CLAUDE.md §9. The companion previously knew nothing about session N when
// session N+1 began — every greeting was cold. This module owns the JSONL
// rollup written at lesson_complete and the prelude read at session start.
//
//   saveSessionMemory({ session_id, lesson_id, summary, ts? })
//     → append one canonical row to vault/.hypha/companion-memory.jsonl
//
//   loadRecentSessions({ lastN, lastNDays? })
//     → read + filter rows (read-only; never throws on missing file).
//
//   buildContextPrelude({ lastN })
//     → short non-LLM "what we touched last time" string ≤200 chars.
//       Caller threads it into the next session's first system context.
//
//   clearMemory({ before_ts? })
//     → manual purge; if before_ts supplied, drop rows older than that.
//
//   summarizeTranscript({ transcript, coherenceScore?, slug?, lesson_id? })
//     → pure roller. Pulled out so tryLessonComplete can stay surgical and
//       so the smoke can exercise the math without filesystem.
//
// Pure I/O wrapper. No LLM calls. Mirrors coherence-log.js patterns for
// vaultRoot resolution + missing-file → empty array + corrupt row tolerance.
// Retention policy: append-only by default; clearMemory({before_ts}) is the
// only purge path until a v0.6 cron lands (documented gap, not regression).

const fs = require('node:fs');
const path = require('node:path');

const VAULT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..', '..', 'vault');
function vaultRoot() {
  return process.env.HYPHA_VAULT_ROOT || VAULT_ROOT_DEFAULT;
}

const MEMORY_REL = path.join('.hypha', 'companion-memory.jsonl');
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PRELUDE_CHAR_CAP = 200;

function _memoryPath() {
  return path.join(vaultRoot(), MEMORY_REL);
}

function _ensureDir(abs) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
}

function _isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function _normalizeThemes(themes) {
  if (!Array.isArray(themes)) return [];
  const seen = new Set();
  const out = [];
  for (const t of themes) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed.slice(0, 40));
    if (out.length >= 3) break;
  }
  return out;
}

function _normalizeArc(arc) {
  if (!Array.isArray(arc)) return [];
  const out = [];
  for (const e of arc) {
    if (typeof e !== 'string') continue;
    const trimmed = e.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, 20));
    if (out.length >= 8) break;
  }
  return out;
}

function _normalizeSummary(summary) {
  if (!_isPlainObject(summary)) return null;
  const emotional_arc = _normalizeArc(summary.emotional_arc);
  const repair_count = Number.isFinite(Number(summary.repair_count))
    ? Math.max(0, Math.floor(Number(summary.repair_count)))
    : 0;
  const cohRaw = Number(summary.coherence_avg);
  const coherence_avg = Number.isFinite(cohRaw) ? cohRaw : null;
  const themes = _normalizeThemes(summary.themes);
  const key_moments = Array.isArray(summary.key_moments)
    ? summary.key_moments
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim().slice(0, 80))
        .slice(0, 3)
    : undefined;
  const out = { emotional_arc, repair_count, coherence_avg, themes };
  if (key_moments && key_moments.length > 0) out.key_moments = key_moments;
  return out;
}

function saveSessionMemory({ session_id, lesson_id, summary, ts } = {}) {
  if (!session_id || typeof session_id !== 'string') {
    return { ok: false, error: 'session_id required' };
  }
  const normalized = _normalizeSummary(summary);
  if (!normalized) {
    return { ok: false, error: 'summary required (object)' };
  }
  const row = {
    ts: ts || new Date().toISOString(),
    op: 'companion:session-memory',
    session_id,
    lesson_id: lesson_id != null ? String(lesson_id) : null,
    summary: normalized,
  };
  const abs = _memoryPath();
  try {
    _ensureDir(abs);
    fs.appendFileSync(abs, JSON.stringify(row) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'append_failed' };
  }
  return { ok: true, row };
}

function _readAllRows() {
  const abs = _memoryPath();
  if (!fs.existsSync(abs)) return [];
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); }
  catch (_) { return []; } // intentional: missing/locked file → empty so callers degrade to "no history"
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); }
    catch (_) { /* skip malformed line, never throw */ } // intentional: tolerate corrupt rows so one bad line doesn't blind us to the rest
  }
  return rows;
}

function loadRecentSessions({ lastN, lastNDays } = {}) {
  let rows = _readAllRows();
  if (Number.isFinite(lastNDays) && lastNDays > 0) {
    const sinceMs = Date.now() - lastNDays * MS_PER_DAY;
    rows = rows.filter((r) => {
      const t = r && r.ts ? Date.parse(r.ts) : NaN;
      return Number.isFinite(t) && t >= sinceMs;
    });
  }
  const n = Number.isFinite(lastN) && lastN > 0 ? Math.floor(lastN) : 5;
  if (rows.length > n) rows = rows.slice(rows.length - n);
  return rows;
}

function _arcGlyph(arc) {
  if (!Array.isArray(arc) || arc.length === 0) return '';
  if (arc.length === 1) return arc[0];
  return arc[0] + '→' + arc[arc.length - 1];
}

function buildContextPrelude({ lastN } = {}) {
  const n = Number.isFinite(lastN) && lastN > 0 ? Math.floor(lastN) : 3;
  const rows = loadRecentSessions({ lastN: n });
  if (rows.length === 0) return '';
  const pieces = [];
  for (const r of rows) {
    if (!r || !r.summary) continue;
    const s = r.summary;
    const tag = r.lesson_id != null ? 'L' + r.lesson_id : (r.session_id || '?');
    const themes = Array.isArray(s.themes) && s.themes.length > 0
      ? s.themes.slice(0, 2).join('/')
      : '';
    const arc = _arcGlyph(s.emotional_arc);
    const fragments = [];
    if (themes) fragments.push(themes);
    if (arc) fragments.push(arc);
    if (Number.isFinite(s.repair_count) && s.repair_count > 0) {
      fragments.push('修' + s.repair_count);
    }
    if (fragments.length === 0) continue;
    pieces.push(tag + ':' + fragments.join(' '));
  }
  if (pieces.length === 0) return '';
  const head = '上次到这里 — ';
  let body = pieces.join('; ');
  const budget = PRELUDE_CHAR_CAP - head.length;
  if (body.length > budget) body = body.slice(0, Math.max(0, budget - 1)) + '…';
  return head + body;
}

function clearMemory({ before_ts } = {}) {
  const abs = _memoryPath();
  if (!fs.existsSync(abs)) return { ok: true, removed: 0, kept: 0 };
  if (!before_ts) {
    try { fs.unlinkSync(abs); return { ok: true, removed: -1, kept: 0 }; }
    catch (err) { return { ok: false, error: (err && err.message) || 'unlink_failed' }; }
  }
  const cutoff = Date.parse(String(before_ts));
  if (!Number.isFinite(cutoff)) {
    return { ok: false, error: 'before_ts not parseable' };
  }
  const rows = _readAllRows();
  const kept = [];
  let removed = 0;
  for (const r of rows) {
    const t = r && r.ts ? Date.parse(r.ts) : NaN;
    if (Number.isFinite(t) && t < cutoff) { removed++; continue; }
    kept.push(r);
  }
  try {
    const body = kept.map((r) => JSON.stringify(r)).join('\n');
    if (body.length === 0) {
      try { fs.unlinkSync(abs); } catch (_) { /* already gone is fine */ }
    } else {
      fs.writeFileSync(abs, body + '\n', 'utf8');
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'rewrite_failed' };
  }
  return { ok: true, removed, kept: kept.length };
}

// ─── Pure roller (no I/O). Pulled out so callers can compose a summary
//     before save, and so the smoke can exercise the math directly.
//
// transcript = [{ text|censored, allowed?, repair_response?, repair?, emotion? }]
// coherenceScore = { score, stability, robustness } | null
// Returns the same shape saveSessionMemory accepts as `summary`.

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '我', '你', '他', '她', '它',
  '我们', '你们', '他们', '这', '那', '一个', '一些', '什么', '哪里',
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'this', 'that', 'these',
  'those', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'as', 'by', 'be',
  'so', 'do', 'did', 'have', 'has', 'had', 'not',
]);

function _extractThemes(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return [];
  const counts = new Map();
  for (const t of transcript) {
    if (!t || typeof t !== 'object') continue;
    const text = t.text || t.censored || '';
    if (!text || typeof text !== 'string') continue;
    const cnChunks = text.match(/[一-鿿]{2,6}/g) || [];
    for (const w of cnChunks) {
      if (STOP_WORDS.has(w)) continue;
      if (w.length < 2) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
    const enWords = text.toLowerCase().match(/[a-z][a-z\-]{2,}/g) || [];
    for (const w of enWords) {
      if (STOP_WORDS.has(w)) continue;
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }
  const ranked = Array.from(counts.entries())
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  return ranked;
}

function _classifyEmotion(text) {
  if (!text || typeof text !== 'string') return null;
  if (/(?:挫败|放弃|烦|烦死|累|崩溃|frustrat|stuck|give\s*up)/i.test(text)) return 'frustrated';
  if (/(?:懂了|明白|清楚|看到了|aha|got it|i see)/i.test(text)) return 'breakthrough';
  if (/(?:不确定|可能|大概|maybe|not sure|hesitan)/i.test(text)) return 'uncertain';
  if (/(?:开心|好玩|有意思|excit|fun|love it)/i.test(text)) return 'curious';
  if (/(?:专注|继续|focus|keep going)/i.test(text)) return 'engaged';
  return null;
}

function summarizeTranscript({ transcript, coherenceScore } = {}) {
  const arr = Array.isArray(transcript) ? transcript : [];
  const arc = [];
  let repairCount = 0;
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    if (typeof t.repair_response === 'string' && t.repair_response.length > 0) repairCount++;
    else if (t.repair === true) repairCount++;
    const tag = typeof t.emotion === 'string'
      ? t.emotion
      : _classifyEmotion(t.text || t.censored || '');
    if (tag) {
      if (arc.length === 0 || arc[arc.length - 1] !== tag) arc.push(tag);
    }
  }
  const coherence_avg = coherenceScore && Number.isFinite(Number(coherenceScore.score))
    ? Number(coherenceScore.score)
    : null;
  return {
    emotional_arc: arc,
    repair_count: repairCount,
    coherence_avg,
    themes: _extractThemes(arr),
  };
}

module.exports = {
  saveSessionMemory,
  loadRecentSessions,
  buildContextPrelude,
  clearMemory,
  summarizeTranscript,
  PRELUDE_CHAR_CAP,
  // Test seams
  _memoryPath,
  _extractThemes,
  _classifyEmotion,
};
