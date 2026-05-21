'use strict';
// HYPHA · Companion Persona Coherence — events log persistence (AMD-MEOW-P8, 2026-05-21).
//
// B1.M1 ship gap #2: scorePersonaCoherence runs on-demand but emits no log
// row, so trend / regression is invisible. This module owns:
//
//   logCoherenceScore({ lesson_id, session_id, scope, score, ts? })
//     → append one JSONL row to vault/.hypha/companion-coherence.jsonl
//
//   readCoherenceLog({ lastN?, sinceMs?, sessionId? })
//     → read + filter rows (read-only; no scheduler).
//
//   getTrend({ sessionId?, lastNDays? })
//     → {trend: 'improving'|'stable'|'declining', delta, samples_count}
//
// Pure I/O wrapper on the vault file. No LLM calls. No mutation of inputs.
// File-missing → empty list (B1 gap #5 backward compat).

const fs = require('node:fs');
const path = require('node:path');

const VAULT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..', '..', 'vault');
function vaultRoot() {
  return process.env.HYPHA_VAULT_ROOT || VAULT_ROOT_DEFAULT;
}

const LOG_REL = path.join('.hypha', 'companion-coherence.jsonl');
const SCOPES = new Set(['turn', 'window', 'session']);
const TREND_DELTA_THRESHOLD = 0.05;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function _logPath() {
  return path.join(vaultRoot(), LOG_REL);
}

function _ensureDir(abs) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
}

function _normalizeScore(score) {
  if (!score || typeof score !== 'object') return null;
  const S = Number(score.S != null ? score.S : score.stability);
  const R = Number(score.R != null ? score.R : score.robustness);
  const combinedRaw = score.combined != null ? score.combined : score.score;
  const combined = Number(combinedRaw);
  if (!Number.isFinite(S) || !Number.isFinite(R) || !Number.isFinite(combined)) return null;
  return { S, R, combined };
}

function logCoherenceScore({ lesson_id, session_id, scope, score, ts } = {}) {
  if (!session_id || typeof session_id !== 'string') {
    return { ok: false, error: 'session_id required' };
  }
  if (!SCOPES.has(scope)) {
    return { ok: false, error: `scope must be one of ${Array.from(SCOPES).join('|')}` };
  }
  const normalized = _normalizeScore(score);
  if (!normalized) {
    return { ok: false, error: 'score requires numeric {S,R,combined}' };
  }
  const row = {
    ts: ts || new Date().toISOString(),
    op: 'companion:coherence-scored',
    lesson_id: lesson_id || null,
    session_id,
    scope,
    score: normalized,
  };
  const abs = _logPath();
  _ensureDir(abs);
  fs.appendFileSync(abs, JSON.stringify(row) + '\n', 'utf8');
  return { ok: true, row };
}

function readCoherenceLog({ lastN, sinceMs, sessionId } = {}) {
  const abs = _logPath();
  if (!fs.existsSync(abs)) return [];
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); }
  catch (_) { return []; } // intentional: log file unreadable mid-write → return empty so callers degrade to "no history" (B1 gap #5 backward compat)
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); }
    catch (_) { /* malformed row — skip, never throw */ } // intentional: skip malformed JSONL row, keep reading the rest
  }
  let filtered = rows;
  if (sessionId) filtered = filtered.filter((r) => r && r.session_id === sessionId);
  if (Number.isFinite(sinceMs)) {
    filtered = filtered.filter((r) => {
      const t = r && r.ts ? Date.parse(r.ts) : NaN;
      return Number.isFinite(t) && t >= sinceMs;
    });
  }
  if (Number.isFinite(lastN) && lastN > 0 && filtered.length > lastN) {
    filtered = filtered.slice(filtered.length - lastN);
  }
  return filtered;
}

function getTrend({ sessionId, lastNDays = 7 } = {}) {
  const sinceMs = Date.now() - lastNDays * MS_PER_DAY;
  const rows = readCoherenceLog({ sinceMs, sessionId });
  const combined = rows
    .map((r) => r && r.score && Number(r.score.combined))
    .filter((v) => Number.isFinite(v));
  if (combined.length < 2) {
    return { trend: 'stable', delta: 0, samples_count: combined.length };
  }
  const half = Math.floor(combined.length / 2);
  const early = combined.slice(0, half);
  const late = combined.slice(combined.length - half);
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const delta = avg(late) - avg(early);
  let trend = 'stable';
  if (delta > TREND_DELTA_THRESHOLD) trend = 'improving';
  else if (delta < -TREND_DELTA_THRESHOLD) trend = 'declining';
  return { trend, delta, samples_count: combined.length };
}

module.exports = {
  logCoherenceScore,
  readCoherenceLog,
  getTrend,
  TREND_DELTA_THRESHOLD,
  // Test seam
  _logPath,
};
