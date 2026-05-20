'use strict';

// HYPHA · Note System §3 v0.5+ · Living Note Reactivation
// ----------------------------------------------------------------------------
// After founder dogfood for 4-6 weeks, vault/<slug>/ accumulates 50+
// lesson-NN.md notes. By default they sit idle — old work goes dusty.
// This module surfaces 1-3 dormant-but-relevant notes when a new lesson
// starts, so the user sees: "上次学的 X 现在用得上 · 7 天前你写了 Y."
//
// Pipeline:
//   1. Scan vault/<slug>/lesson-*.md → list { path, idx, mtime, bytes, text }.
//   2. Filter eligibility:
//        - mtime ≥ minAgeDays days ago (default 7; opts.minAgeDays=0 disables age gate).
//        - lesson_idx ≠ currentLessonIdx (skip self).
//        - file bytes ≥ MIN_NOTE_BYTES (skip stubs).
//   3. Compute relevance: token-jaccard between currentLessonText and note body
//      (CJK + ascii, stopwords stripped). jaccard >= JACCARD_FLOOR keeps the
//      candidate. Top JACCARD_TOPK by score feed Stage 2.
//   4. Stage 2: executeChat('T4_JUDGE', ...) picks 1-3 candidates that are
//      genuinely worth resurrecting and writes per-candidate `reason` +
//      `transfer_point` prose. Returns [] when the model judges none relevant.
//   5. Return { candidates, summary } — callers (main.js) emit to renderer.
//
// Side-effect free: never writes vault, never mutates state.json.
// LLM failure is non-fatal: when executeChat throws or returns garbage,
// we fall back to a deterministic top-3 by jaccard with template reasons
// so the renderer still gets something useful instead of a hard error.

const fs   = require('node:fs');
const path = require('node:path');

const MIN_NOTE_BYTES     = 800;
const DEFAULT_MIN_AGE_DAYS = 7;
const JACCARD_FLOOR      = 0.05;
const JACCARD_TOPK       = 8;
const QUERY_HEAD_CHARS   = 800;
const NOTE_PREVIEW_CHARS = 300;
const LLM_MAX_PICKS      = 3;
const LLM_MAX_TOKENS     = 900;

// Stopword set — small, biased to drop common CN + EN filler that
// inflates jaccard between two pedagogical paragraphs that share
// register-words but no actual concepts.
const STOPWORDS = new Set([
  // EN
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'and', 'or', 'but', 'if', 'then', 'so', 'as', 'of', 'in', 'on', 'at',
  'to', 'for', 'with', 'by', 'from', 'this', 'that', 'these', 'those',
  'it', 'its', 'you', 'your', 'we', 'us', 'our', 'they', 'them', 'their',
  'i', 'me', 'my', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'should', 'have', 'has', 'had', 'not', 'no', 'yes',
  // CN — Hypha 文案常见 filler
  '的', '了', '是', '在', '和', '与', '及', '或', '但', '而', '也', '就',
  '都', '把', '被', '给', '让', '到', '从', '对', '为', '所', '以', '于',
  '一', '二', '三', '个', '些', '这', '那', '此', '其', '中', '上', '下',
  '不', '有', '没', '说', '看', '想', '要', '能', '会', '可', '该',
  '你', '我', '他', '她', '它', '们', '自己', '什么', '怎么', '为什么',
]);

function _resolveSlugDir(slug) {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return path.join(process.env.HYPHA_DATA, slug);
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return path.join(process.env.HYPHA_VAULT_DIR, slug);
  }
  // hypha/app/lib/note-system/living-reactivation.js → hypha/data
  return path.join(__dirname, '..', '..', '..', 'data', slug);
}

function _listLessonNotes(slugDir) {
  const out = [];
  if (!slugDir || !fs.existsSync(slugDir)) return out;
  let entries = [];
  try { entries = fs.readdirSync(slugDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const m = /^lesson-(\d+)\.md$/i.exec(dirent.name);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (!Number.isFinite(idx)) continue;
    const abs = path.join(slugDir, dirent.name);
    let stat = null;
    try { stat = fs.statSync(abs); } catch (_) { continue; }
    out.push({
      idx,
      path: abs,
      mtimeMs: stat.mtimeMs || 0,
      bytes: stat.size || 0,
    });
  }
  return out;
}

function _stripFrontmatter(text) {
  return String(text || '').replace(/^---[\s\S]*?---\r?\n?/, '');
}

function _safeReadFull(abs) {
  try { return fs.readFileSync(abs, 'utf-8'); } catch (_) { return ''; }
}

function _ageDays(mtimeMs, nowMs) {
  if (!mtimeMs) return Infinity;
  return Math.max(0, (nowMs - mtimeMs) / (1000 * 60 * 60 * 24));
}

// Tokenize for jaccard: lowercase ascii word-runs + each CJK char as token.
// Strips stopwords. Used on both query + each note body.
function _tokens(text) {
  const body = _stripFrontmatter(text);
  const out = new Set();
  const ascii = body.toLowerCase().match(/[a-z0-9_]{2,}/g) || [];
  for (const t of ascii) {
    if (!STOPWORDS.has(t)) out.add(t);
  }
  const cjk = body.match(/[一-鿿]/g) || [];
  for (const ch of cjk) {
    if (!STOPWORDS.has(ch)) out.add(ch);
  }
  return out;
}

function _jaccard(aSet, bSet) {
  if (!aSet || !bSet || aSet.size === 0 || bSet.size === 0) return 0;
  let inter = 0;
  const [small, big] = aSet.size <= bSet.size ? [aSet, bSet] : [bSet, aSet];
  for (const tok of small) {
    if (big.has(tok)) inter++;
  }
  const union = aSet.size + bSet.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

function _previewNote(fullText) {
  const stripped = _stripFrontmatter(fullText).trim().replace(/\s+/g, ' ');
  if (stripped.length <= NOTE_PREVIEW_CHARS) return stripped;
  return stripped.slice(0, NOTE_PREVIEW_CHARS) + '…';
}

function _fallbackReason(ageDays) {
  const d = Math.round(ageDays);
  return `${d} 天前的笔记, 与当前内容主题相近, 可作为前置参考.`;
}

function _fallbackTransfer() {
  return '当前一节里你会用到这条旧笔记的核心结论.';
}

function _truncate(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

// Build the user prompt for the T4_JUDGE pick. Keep it tight — small note
// previews + clear JSON schema. Returns { system, user, payloadCandidates }.
function _buildPrompt(currentLessonText, topCandidates) {
  const system = [
    '你在帮一位学习者复活旧笔记。从给定候选中挑出真正"现在用得上"的 1-3 条。',
    '规则:',
    '- 不要硬凑。如果都不真相关, 返回 selected = []。',
    '- 每条 reason 1-2 句, transfer_point 1 句, 具体指向迁移到当前一节的什么地方。',
    '- 优雅, 简练, 避免 AI 流量词 ("这一刀" / "闭环" / "拉满" / "干货" / "yyds" 等)。',
    '- 严格 JSON, 字段 = {selected:[{note_idx, reason, transfer_point, rank}]}',
    '- rank 1 = 最重要; 至多 3 条。',
  ].join('\n');

  const lines = [];
  lines.push('当前要学的内容 (头 800 字):');
  lines.push(_truncate(currentLessonText || '', QUERY_HEAD_CHARS));
  lines.push('');
  lines.push(`旧笔记候选 (${topCandidates.length} 条, 各约 300 字摘要):`);
  for (let i = 0; i < topCandidates.length; i++) {
    const c = topCandidates[i];
    lines.push(`${i + 1}. [note_idx=${c.note_idx}, ${Math.round(c.age_days)} 天前]`);
    lines.push(c.preview);
    lines.push('');
  }
  lines.push('返回 JSON, 仅 selected 字段。');
  return { system, user: lines.join('\n') };
}

function _coerceLLMResult(raw) {
  // executeChat returns { result, ... } where result is parsed JSON when
  // json:true. We accept either the wrapper or the parsed body.
  if (!raw) return null;
  if (raw.result != null) raw = raw.result;
  if (typeof raw === 'string') {
    // Best-effort parse — LLM occasionally returns text-wrapped JSON.
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { raw = JSON.parse(m[0]); } catch (_) { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const selected = Array.isArray(raw.selected) ? raw.selected : [];
  return selected
    .map((s) => {
      const idx = Number(s && (s.note_idx !== undefined ? s.note_idx : s.idx));
      if (!Number.isFinite(idx)) return null;
      const reason = String((s && s.reason) || '').trim();
      const transfer = String((s && (s.transfer_point || s.transferPoint)) || '').trim();
      const rank = Number.isFinite(Number(s && s.rank)) ? Number(s.rank) : 99;
      return { note_idx: idx, reason, transfer_point: transfer, rank };
    })
    .filter(Boolean)
    .slice(0, LLM_MAX_PICKS);
}

/**
 * Find reactivation candidates for the lesson the user is about to start.
 *
 * @param {object} args
 * @param {string} args.slug                 vault subdir name
 * @param {number} args.currentLessonIdx     lesson the user is about to enter
 * @param {string} args.currentLessonText    body / brief / outline of that lesson
 * @param {object} [args.settings]           hypha settings (reserved; unused today)
 * @param {object} [args.opts]
 * @param {number} [args.opts.minAgeDays]    age floor for eligibility (default 7; 0 disables)
 * @param {number} [args.opts.maxResults]    cap on selected (default 3, ≤ LLM_MAX_PICKS)
 * @param {function} [args.opts._executeChat] DI override for tests
 * @returns {Promise<{candidates: Array, summary: object}>}
 */
async function findReactivationCandidates(args = {}) {
  const slug = String((args && args.slug) || '').trim();
  const currentLessonIdx = Number.isFinite(Number(args && args.currentLessonIdx))
    ? Number(args.currentLessonIdx) : -1;
  const currentLessonText = String((args && args.currentLessonText) || '');
  const opts = (args && args.opts) || {};
  const minAgeDays = Number.isFinite(Number(opts.minAgeDays))
    ? Number(opts.minAgeDays) : DEFAULT_MIN_AGE_DAYS;
  const maxResults = Math.max(1, Math.min(LLM_MAX_PICKS,
    Number.isFinite(Number(opts.maxResults)) ? Number(opts.maxResults) : LLM_MAX_PICKS));

  const summary = {
    total_notes_scanned: 0,
    notes_eligible_by_age: 0,
    notes_above_jaccard_threshold: 0,
    llm_selected: 0,
    fallback_used: false,
    error: null,
  };

  if (!slug) {
    summary.error = 'BAD_INPUT_SLUG';
    return { candidates: [], summary };
  }

  const slugDir = _resolveSlugDir(slug);
  const allNotes = _listLessonNotes(slugDir);
  summary.total_notes_scanned = allNotes.length;
  if (allNotes.length === 0) return { candidates: [], summary };

  const now = Date.now();
  const eligible = [];
  for (const n of allNotes) {
    if (n.idx === currentLessonIdx) continue;
    if (n.bytes < MIN_NOTE_BYTES) continue;
    const ageDays = _ageDays(n.mtimeMs, now);
    if (minAgeDays > 0 && ageDays < minAgeDays) continue;
    eligible.push({ ...n, ageDays });
  }
  summary.notes_eligible_by_age = eligible.length;
  if (eligible.length === 0) return { candidates: [], summary };

  const qTokens = _tokens(currentLessonText);
  if (qTokens.size === 0) {
    // No query text — nothing meaningful to score against.
    return { candidates: [], summary };
  }

  // Score eligible notes.
  const scored = [];
  for (const n of eligible) {
    const full = _safeReadFull(n.path);
    if (!full) continue;
    const dTokens = _tokens(full);
    const j = _jaccard(qTokens, dTokens);
    if (j < JACCARD_FLOOR) continue;
    scored.push({
      note_idx: n.idx,
      jaccard: Math.round(j * 1000) / 1000,
      age_days: Math.round(n.ageDays * 10) / 10,
      file_path: n.path,
      preview: _previewNote(full),
    });
  }
  summary.notes_above_jaccard_threshold = scored.length;
  if (scored.length === 0) return { candidates: [], summary };

  scored.sort((a, b) => b.jaccard - a.jaccard);
  const topK = scored.slice(0, JACCARD_TOPK);

  // Stage 2 — T4_JUDGE LLM pick.
  let llmPicked = null;
  const executeChatFn = (opts && typeof opts._executeChat === 'function')
    ? opts._executeChat
    : (() => {
        try { return require('../llm').executeChat; } catch (_) { return null; }
      })();

  if (typeof executeChatFn === 'function') {
    const { system, user } = _buildPrompt(currentLessonText, topK);
    try {
      const raw = await executeChatFn('T4_JUDGE', {
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user },
        ],
        json: true,
        maxTokens: LLM_MAX_TOKENS,
        temperature: 0.2,
      });
      llmPicked = _coerceLLMResult(raw);
    } catch (err) {
      summary.error = `llm:${err && err.message ? err.message : String(err)}`.slice(0, 200);
    }
  }

  // Merge LLM picks back with jaccard / file info. Fallback: top-3 by jaccard
  // with template prose so the surface still has something to render.
  let merged = [];
  if (Array.isArray(llmPicked) && llmPicked.length > 0) {
    for (const pick of llmPicked) {
      const base = topK.find((c) => c.note_idx === pick.note_idx);
      if (!base) continue;
      merged.push({
        note_idx: base.note_idx,
        jaccard: base.jaccard,
        age_days: base.age_days,
        file_path: base.file_path,
        preview: base.preview,
        reason: pick.reason || _fallbackReason(base.age_days),
        transfer_point: pick.transfer_point || _fallbackTransfer(),
        rank: pick.rank,
      });
    }
    merged.sort((a, b) => (a.rank || 99) - (b.rank || 99));
  }

  if (merged.length === 0) {
    summary.fallback_used = true;
    merged = topK.slice(0, maxResults).map((c, i) => ({
      note_idx: c.note_idx,
      jaccard: c.jaccard,
      age_days: c.age_days,
      file_path: c.file_path,
      preview: c.preview,
      reason: _fallbackReason(c.age_days),
      transfer_point: _fallbackTransfer(),
      rank: i + 1,
    }));
  }

  const candidates = merged.slice(0, maxResults);
  summary.llm_selected = candidates.length;

  return { candidates, summary };
}

module.exports = {
  findReactivationCandidates,
  // exposed for tests / external linkage
  MIN_NOTE_BYTES,
  DEFAULT_MIN_AGE_DAYS,
  JACCARD_FLOOR,
  JACCARD_TOPK,
  _tokens,
  _jaccard,
};
