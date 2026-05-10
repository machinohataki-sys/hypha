'use strict';

// STAKE block extractor for Hypha Learn mode.
//
// Per Gemini LearnLM principles, this block is INPUT-LAYER substrate
// injected ABOVE the user message — not in the system prompt — so the
// model perceives "what's happening right now" instead of abstract framing.
// Mirrors hypha-constitution.userProfileBlock: named export returning a
// string; '' when no signal. Lines are omitted entirely when their data
// is missing. Every read failure is silently swallowed.

const fs   = require('node:fs');
const fsp  = require('node:fs/promises');
const readline = require('node:readline');

const MAX_UTTERANCE = 200;
const MAX_MISS_TEXT = 100;
const MAX_UNRESOLVED = 3;
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
const ONE_DAY_MS = 24 * 3600 * 1000;
const RECENT_DRAFT_MAX_CHARS = 200;
const PREDICTION_SCAN_LIMIT = 50;
const PREDICTION_DELTA_THRESHOLD = 0.5;

function clip(str, max) {
  if (typeof str !== 'string') return '';
  const s = str.trim();
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function pickLastUtterance(transcript) {
  if (!Array.isArray(transcript)) return null;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i];
    if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return clip(m.content, MAX_UTTERANCE);
    }
  }
  return null;
}

async function pickLastMiss(eventLogPath) {
  if (!eventLogPath) return null;
  try { await fsp.access(eventLogPath); } catch (_) { return null; }
  const lines = [];
  try {
    const stream = fs.createReadStream(eventLogPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) { if (line) lines.push(line); }
  } catch (_) { return null; }
  const start = Math.max(0, lines.length - PREDICTION_SCAN_LIMIT);
  for (let i = lines.length - 1; i >= start; i--) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!ev || ev.type !== 'prediction') continue;
    const delta = Number(ev.delta_norm);
    if (!Number.isFinite(delta) || delta <= PREDICTION_DELTA_THRESHOLD) continue;
    if (typeof ev.concept === 'string' && ev.concept.trim()) return clip(ev.concept, MAX_MISS_TEXT);
    if (typeof ev.topic === 'string' && ev.topic.trim()) return clip(ev.topic, MAX_MISS_TEXT);
    if (typeof ev.text === 'string' && ev.text.trim()) return clip(ev.text, MAX_MISS_TEXT);
    return null;
  }
  return null;
}

function pickUnresolved(curriculum) {
  if (!curriculum || !Array.isArray(curriculum.lessons)) return [];
  const out = [];
  for (const lesson of curriculum.lessons) {
    if (!lesson || lesson.state === 'settled') continue;
    const id = lesson.id != null ? String(lesson.id) : '';
    const title = typeof lesson.title === 'string' ? lesson.title : '';
    if (!id && !title) continue;
    out.push(id && title ? `${id}: ${title}` : (id || title));
    if (out.length >= MAX_UNRESOLVED) break;
  }
  return out;
}

async function pickVaultTension(vaultRoot) {
  if (!vaultRoot) return null;
  let listMod;
  try { listMod = require('../vault.js'); } catch (_) { return null; }
  const prevEnv = process.env.HYPHA_DATA;
  let restored = false;
  try {
    if (vaultRoot !== prevEnv) { process.env.HYPHA_DATA = vaultRoot; restored = true; }
    let result;
    try { result = listMod.list(); } catch (_) { return null; }
    if (!result || !Array.isArray(result.folders)) return null;
    const now = Date.now();
    const sevenAgo = now - SEVEN_DAYS_MS;
    for (const folder of result.folders) {
      if (!folder || !Array.isArray(folder.items)) continue;
      for (const item of folder.items) {
        if (!item || !item.mtime) continue;
        const mtimeMs = Date.parse(item.mtime);
        if (!Number.isFinite(mtimeMs) || mtimeMs < sevenAgo) continue;
        const title = (item.label || '').replace(/\.md$/i, '');
        let body = '';
        try { const r = listMod.read(item.rel); body = (r && r.body) || ''; } catch (_) {}
        if (body.includes('<!-- conflict -->')) return title;
        if ((now - mtimeMs) < ONE_DAY_MS && body.length < RECENT_DRAFT_MAX_CHARS) return title;
      }
    }
    return null;
  } finally {
    if (restored) {
      if (prevEnv === undefined) delete process.env.HYPHA_DATA;
      else process.env.HYPHA_DATA = prevEnv;
    }
  }
}

async function buildStakeBlock(opts) {
  const o = opts || {};
  const lines = [];

  const utt = pickLastUtterance(o.transcript);
  if (utt) lines.push(`last_utterance: ${JSON.stringify(utt)}`);

  let miss = null;
  try { miss = await pickLastMiss(o.eventLogPath); } catch (_) {}
  if (miss) lines.push(`last_miss: ${JSON.stringify(miss)}`);

  const unresolved = pickUnresolved(o.curriculum);
  if (unresolved.length > 0) lines.push(`unresolved: ${JSON.stringify(unresolved)}`);

  let tension = null;
  try { tension = await pickVaultTension(o.vaultRoot); } catch (_) {}
  if (tension) lines.push(`vault_tension: ${JSON.stringify(tension)}`);

  if (lines.length === 0) return '';
  return ['[STAKE]', ...lines, '[/STAKE]'].join('\n');
}

module.exports = { buildStakeBlock };
