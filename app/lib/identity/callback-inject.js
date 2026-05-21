'use strict';
// HYPHA · Callback Inject (Phase D.1, 2026-05-18)
//
// Read-side. ! 写 vault. Job: take chainSlug + current lessonIdx, return a
// prompt-fragment string the lesson generator MUST include so lesson-N
// references user's actual prior productions from lesson N-1/N-2/N-3.
//
// 为什么: council verdict — Hattie d=0.72 relationship 主轴. HYPHA 当前
// lesson 生成 prompt 没显式 dump user 历史输出, LLM session memory ! 可靠
// (multi-session 跨天 100% 失忆). 必须从 events.jsonl + tutor-identity.json
// 显式提取 dump 到 prompt — 这是 identity 的可执行 implementation, ! abstract.
//
// API:
//   extractRecentUserProductions({chainSlug, lessonIdx, lookback=3}) → {productions, sources}
//   formatCallbackBlock(productions, identity) → string (prompt fragment)
//   buildCallbackBlockForLesson({chainSlug, lessonIdx, lookback=3}) → string (composed)

const vault = require('../vault');
const { loadIdentity } = require('./tutor-identity');

const DEFAULT_LOOKBACK = 3;
const MAX_PRODUCTIONS_PER_LESSON = 2;
const MIN_TEXT_LEN = 8;  // skip "ok" / "好" / single-word replies
const MAX_TEXT_LEN = 400;

/**
 * Pull user-produced text for lessons in range [lessonIdx - lookback, lessonIdx - 1].
 * Three sources merged with dedup:
 *   PRIMARY · sessions/L<NN>-*.jsonl rows with role='user' (HYPHA's actual transcript)
 *   SECONDARY · events.jsonl rows with type=user_message|lesson_user_turn|user_artifact_submitted
 *   TERTIARY · tutor-identity.established_priors[]
 *
 * Session shape (per main.js _sessionPathFor): `<slug>/sessions/L<idx_padStart2>-<ISO>.jsonl`.
 * Each row carries {role, text, idx, ...}. Multiple session files per lesson tolerated
 * (resume creates new file).
 *
 * Returns at most lookback × MAX_PRODUCTIONS_PER_LESSON entries, newest-first.
 *
 * @param {{chainSlug: string, lessonIdx: number, lookback?: number}} args
 * @returns {{productions: Array<{lesson_idx, text, source}>, sources: {sessions_count, events_count, identity_count}}}
 */
function extractRecentUserProductions({ chainSlug, lessonIdx, lookback = DEFAULT_LOOKBACK } = {}) {
  if (!chainSlug || !Number.isFinite(lessonIdx)) {
    return { productions: [], sources: { sessions_count: 0, events_count: 0, identity_count: 0 } };
  }

  const startIdx = Math.max(0, lessonIdx - lookback);
  const endIdx = lessonIdx - 1;
  if (endIdx < 0) return { productions: [], sources: { sessions_count: 0, events_count: 0, identity_count: 0 } };

  // PRIMARY — session JSONL transcripts (HYPHA's actual chat persistence)
  const sessionEntries = [];
  try {
    const dirRel = `${chainSlug}/sessions`;
    const entries = vault.listDir(dirRel);
    if (Array.isArray(entries) && entries.length > 0) {
      for (let idx = startIdx; idx <= endIdx; idx++) {
        const prefix = `L${String(idx).padStart(2, '0')}-`;
        for (const e of entries) {
          if (e.isDir || !e.name.startsWith(prefix) || !e.name.endsWith('.jsonl')) continue;
          let rows = [];
          try { rows = vault.readJSONL(`${dirRel}/${e.name}`); } catch (_) { continue; }
          for (const row of rows) {
            if (!row || row.role !== 'user') continue;
            const text = String(row.text || row.user_text || row.content || '').trim();
            if (text.length < MIN_TEXT_LEN) continue;
            sessionEntries.push({
              lesson_idx: idx,
              text: text.slice(0, MAX_TEXT_LEN),
              source: 'session',
            });
          }
        }
      }
    }
  } catch (_) { /* sessions dir missing → fall through */ }

  // SECONDARY — events.jsonl (some HYPHA paths may emit user-message-typed rows)
  const eventEntries = [];
  try {
    const rows = vault.readJSONL(`${chainSlug}/events.jsonl`);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const li = Number(row.lesson_idx);
      if (!Number.isFinite(li)) continue;
      if (li < startIdx || li > endIdx) continue;
      let text = null;
      const t = row.type || row.op;
      if (t === 'user_message' && typeof row.content === 'string') text = row.content;
      else if (t === 'lesson_user_turn' && typeof row.user_text === 'string') text = row.user_text;
      else if (t === 'user_artifact_submitted' && typeof row.text === 'string') text = row.text;
      if (!text) continue;
      const trimmed = text.trim();
      if (trimmed.length < MIN_TEXT_LEN) continue;
      eventEntries.push({
        lesson_idx: li,
        text: trimmed.slice(0, MAX_TEXT_LEN),
        source: 'events',
      });
    }
  } catch (_) { /* events.jsonl missing or unreadable */ }

  // TERTIARY — identity established_priors[] (explicit appendPrior fallback)
  const identityEntries = [];
  try {
    const id = loadIdentity(chainSlug);
    for (const p of id.established_priors) {
      const li = Number(p && p.lesson_idx);
      if (!Number.isFinite(li)) continue;
      if (li < startIdx || li > endIdx) continue;
      const text = (p.user_produced_text || '').trim();
      if (text.length < MIN_TEXT_LEN) continue;
      identityEntries.push({
        lesson_idx: li,
        text: text.slice(0, MAX_TEXT_LEN),
        source: 'identity',
      });
    }
  } catch (_) { /* identity load failed */ }

  // Merge: bucket by lesson_idx, dedup by 30-char prefix overlap, cap per lesson.
  const byLesson = new Map();
  const _mergeBucket = (entries) => {
    for (const e of entries) {
      const bucket = byLesson.get(e.lesson_idx) || [];
      const dup = bucket.some(b => b.text.includes(e.text.slice(0, 30)) || e.text.includes(b.text.slice(0, 30)));
      if (!dup) bucket.push(e);
      byLesson.set(e.lesson_idx, bucket);
    }
  };
  _mergeBucket(sessionEntries);   // primary
  _mergeBucket(eventEntries);     // secondary
  _mergeBucket(identityEntries);  // tertiary

  const productions = [];
  const sortedLessons = Array.from(byLesson.keys()).sort((a, b) => b - a); // newest first
  for (const li of sortedLessons) {
    const bucket = byLesson.get(li);
    for (const e of bucket.slice(0, MAX_PRODUCTIONS_PER_LESSON)) productions.push(e);
  }

  return {
    productions,
    sources: {
      sessions_count: sessionEntries.length,
      events_count: eventEntries.length,
      identity_count: identityEntries.length,
    },
  };
}

/**
 * Format a list of productions into a prompt fragment. Garamond register —
 * lowercase headers, no SaaS gushing. Empty productions → empty string
 * (let caller decide whether to emit a "first lesson, no prior callback"
 * notice or omit entirely).
 *
 * @param {Array<{lesson_idx, text, source}>} productions
 * @param {{voice_name?: string}} identity
 * @returns {string}
 */
function formatCallbackBlock(productions, identity) {
  if (!Array.isArray(productions) || productions.length === 0) return '';
  const voice = (identity && identity.voice_name) || 'Victor';
  const lines = [
    '── 上节回声 (callback to user productions) ──',
    `本节由 ${voice} 续讲. 必须引用以下 user 实写原文 (≥ 5 字, ! 改写, ! 概括), 把本节内容挂回去:`,
  ];
  for (const p of productions) {
    lines.push(`  [lesson-${p.lesson_idx}] "${p.text.replace(/\s+/g, ' ').slice(0, 200)}"`);
  }
  lines.push('');
  lines.push('要求:');
  lines.push('  - 至少引用上面 1 条原话 (≥ 5 字), 用作 anchor;');
  lines.push('  - 在本节中显示 acknowledge: user 上节产出了 X, 本节将延续 / 反驳 / 深化;');
  lines.push('  - ! 空 callback. ! 套话 ("延续上节" 单独一句不算 callback).');
  lines.push('──');
  return lines.join('\n');
}

/**
 * Compose: load identity + extract productions + format. One-call entry for
 * lesson generators. Returns empty string when no callback material (lesson 0
 * or fresh chain) — caller can safely concatenate.
 *
 * @param {{chainSlug: string, lessonIdx: number, lookback?: number}} args
 * @returns {string}
 */
function buildCallbackBlockForLesson({ chainSlug, lessonIdx, lookback = DEFAULT_LOOKBACK } = {}) {
  if (!chainSlug || !Number.isFinite(lessonIdx) || lessonIdx <= 0) return '';
  const { productions } = extractRecentUserProductions({ chainSlug, lessonIdx, lookback });
  if (productions.length === 0) return '';
  const identity = loadIdentity(chainSlug);
  return formatCallbackBlock(productions, identity);
}

/**
 * Format productions for the LESSON ARCHITECT (prep stage, ! teaching).
 * Architect's job = prepare the 11-field LESSON BRIEF. Block tells architect
 * which user productions to anchor canonical_example + note_connection on,
 * without telling architect HOW to teach (that's the tutor's job downstream).
 *
 * Format differs from formatCallbackBlock — architect receives raw production
 * data + concrete schema-field guidance, ! teacher-voice instructions.
 *
 * @param {Array<{lesson_idx, text, source}>} productions
 * @param {{voice_name?: string}} [identity]
 * @returns {string}
 */
function formatCallbackBlockForArchitect(productions, identity) {
  if (!Array.isArray(productions) || productions.length === 0) return '';
  const lines = [
    'PRIOR USER PRODUCTIONS (callback material — the user has written these in earlier lessons of this chain):',
  ];
  for (const p of productions) {
    lines.push(`  [lesson-${p.lesson_idx}] "${p.text.replace(/\s+/g, ' ').slice(0, 220)}"`);
  }
  lines.push('');
  lines.push('REQUIREMENT — bake into the body fields:');
  lines.push('  - note_connection MUST name which prior lesson the new one bridges + quote ≥ 5 chars of user text verbatim (no paraphrase).');
  lines.push('  - canonical_example MAY use user\'s own production as anchor when natural (preferred over generic textbook example).');
  lines.push('  - mechanism_explanation should reference / extend / disambiguate the priors above when topic adjacent.');
  lines.push('  - ! generic "延续上节" boilerplate. ! invented user words. Quote only what is shown above.');
  return lines.join('\n');
}

/**
 * Architect-facing one-call composer. Same input shape as buildCallbackBlockForLesson
 * but emits architect format. Empty string when no productions to callback.
 *
 * @param {{chainSlug: string, lessonIdx: number, lookback?: number}} args
 * @returns {string}
 */
function buildCallbackBlockForArchitect({ chainSlug, lessonIdx, lookback = DEFAULT_LOOKBACK } = {}) {
  if (!chainSlug || !Number.isFinite(lessonIdx) || lessonIdx <= 0) return '';
  const { productions } = extractRecentUserProductions({ chainSlug, lessonIdx, lookback });
  if (productions.length === 0) return '';
  const identity = loadIdentity(chainSlug);
  return formatCallbackBlockForArchitect(productions, identity);
}

module.exports = {
  extractRecentUserProductions,
  formatCallbackBlock,
  buildCallbackBlockForLesson,
  formatCallbackBlockForArchitect,
  buildCallbackBlockForArchitect,
  _internals: { DEFAULT_LOOKBACK, MAX_PRODUCTIONS_PER_LESSON, MIN_TEXT_LEN, MAX_TEXT_LEN },
};
