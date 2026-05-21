'use strict';

// HYPHA · β14 Cross-Spark Engine (Growth System §28, BLUEPRINT §28).
//
// MVP: 给一个 lesson 概念 X (archetype A), 横向找 k 个跨域 unexpected resonance.
// 素材池 = persona-wisdom (5+ 蒸馏 persona) + 其它 archetype 的 lesson 正文.
//
// 不同于 W7.4 `app/lib/cross-spark/engine.js` (4-domain literature/science/
// engineering/ai 静态轴) — 本模块 archetype-aware + 用真实蒸馏 corpus +
// LLM 出 resonance claim (无 mock fallback, 反 Apparent-Success-Seeking).
//
// Public surface:
//   generateCrossSparks({ slug, concept, k = 3, dryRun = false })
//     → { ok:true, sparks, candidatesUsed, llmAttempts }
//     | { ok:false, error: 'NO_LLM_KEY'|'NO_CANDIDATES'|'LLM_PARSE'|'EXCEPTION', ... }
//   listCrossSparks({ slug, limit = 50 })
//     → { ok:true, rows }  // 反向 (新→旧) 最近 limit 行
//
// Errors are returned, not thrown — IPC boundary is `{ok, ...}` envelope.

const fs = require('node:fs');
const path = require('node:path');

const { resolveRoot } = require('../vault');

// archetype 枚举 (per BLUEPRINT)
const ARCHETYPES = Object.freeze([
  'HUMANITIES', 'TECH', 'SCIENCE', 'LANG-ACQ', 'MINDSET', 'ATHLETICS',
]);

// candidate pool 上限: persona 优先到 6, 然后 lessons 填到 12.
const MAX_PERSONA = 6;
const MAX_CANDIDATES = 12;

// 每个 lesson 正文 snippet 头字符数
const LESSON_SNIPPET_CHARS = 500;
// persona body snippet 头字符数 (frontmatter 之后)
const PERSONA_SNIPPET_CHARS = 800;

// Strength gate. Below 0.3 → noise (LLM resonance survives token-level Jaccard
// floor or the link is too thin to act on). Override per-call via `minStrength`.
const MIN_STRENGTH_DEFAULT = 0.3;
// Stopword + tokenization for strength scoring. Mixed zh/en — keep narrow
// (filters obvious connectives only, do not over-filter content tokens).
const STRENGTH_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'was',
  'were', 'be', 'with', 'for', 'as', 'at', 'by', 'this', 'that', 'these', 'those',
  '的', '是', '在', '和', '与', '了', '也', '都', '就', '而', '但', '又',
]);

function _tokenize(s) {
  if (typeof s !== 'string') return [];
  // \p{L}+ matches Unicode letter runs (handles CJK + Latin); lowercase Latin
  // for case-insensitive overlap.
  const raw = s.toLowerCase().match(/\p{L}+/gu) || [];
  return raw.filter(t => t.length > 1 && !STRENGTH_STOPWORDS.has(t));
}

// Jaccard over token sets — single in-file pure function, no embeddings dep.
// Returns 0..1. Empty sets → 0 (not 1, NaN). Used both for spark strength
// scoring and surface-level resonance gating.
function _computeStrength(conceptText, candidateSnippet) {
  const a = new Set(_tokenize(conceptText));
  const b = new Set(_tokenize(candidateSnippet));
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

function _readText(abs) {
  try { return fs.readFileSync(abs, 'utf-8'); } catch (_) { return ''; }
}

// 简单 frontmatter 解析 — 仅取 key:value (lowercased key), value 去引号.
// 不复用 vault.parseFrontmatter (未导出); body 字段在 cross-spark 上下文很重要.
function _splitFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fm, body: m[2] || '' };
}

// 收集 persona-wisdom: 跳过 status === 'WAITING_DISTILL'
function _collectPersonaWisdom(vaultRoot) {
  const dir = path.join(vaultRoot, '.persona-wisdom');
  if (!fs.existsSync(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.toLowerCase().endsWith('.md')) continue;
    const abs = path.join(dir, ent.name);
    const text = _readText(abs);
    if (!text) continue;
    const { fm, body } = _splitFrontmatter(text);
    const status = String(fm.status || '').toUpperCase();
    if (status === 'WAITING_DISTILL') continue;
    const personaId = ent.name.replace(/\.md$/i, '');
    const displayName = fm.display_name || fm['display-name'] || personaId;
    const snippet = (body || '').slice(0, PERSONA_SNIPPET_CHARS).trim();
    if (!snippet) continue;
    out.push({
      source_id: `persona:${personaId}`,
      source_type: 'persona',
      archetype: 'CROSS',
      display_name: displayName,
      snippet,
    });
  }
  return out;
}

// 收集其它 archetype 的 lesson-01 / lesson-02 头 500 字符
function _collectOtherLessons(vaultRoot, sourceArchetype) {
  let folders;
  try { folders = fs.readdirSync(vaultRoot, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const d of folders) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith('.') || d.name.startsWith('_')) continue;
    const otherSlug = d.name;
    const stateAbs = path.join(vaultRoot, otherSlug, 'state.json');
    if (!fs.existsSync(stateAbs)) continue;
    let state = null;
    try { state = JSON.parse(_readText(stateAbs) || 'null'); }
    catch (_) { state = null; }
    if (!state || typeof state !== 'object') continue;
    const otherArchetype = String(state.archetype || 'UNKNOWN').toUpperCase();
    if (sourceArchetype && otherArchetype === sourceArchetype) continue;
    // 取 lesson-01 + lesson-02 (各头 500 字符)
    for (const idx of [1, 2]) {
      const lessonName = `lesson-${String(idx).padStart(2, '0')}.md`;
      const lessonAbs = path.join(vaultRoot, otherSlug, lessonName);
      if (!fs.existsSync(lessonAbs)) continue;
      const text = _readText(lessonAbs);
      if (!text) continue;
      const { body } = _splitFrontmatter(text);
      const snippet = (body || '').slice(0, LESSON_SNIPPET_CHARS).trim();
      if (!snippet) continue;
      out.push({
        source_id: `lesson:${otherSlug}/${idx}`,
        source_type: 'lesson',
        archetype: otherArchetype,
        slug: otherSlug,
        lesson_idx: idx,
        snippet,
      });
    }
  }
  return out;
}

// 拼候选池: persona 优先到 MAX_PERSONA, lessons 填到 MAX_CANDIDATES.
function _assembleCandidates(personas, lessons) {
  const pCap = personas.slice(0, MAX_PERSONA);
  const remaining = Math.max(0, MAX_CANDIDATES - pCap.length);
  const lCap = lessons.slice(0, remaining);
  return [...pCap, ...lCap];
}

function _buildMessages({ concept, sourceArchetype, k, candidates }) {
  const system =
    '你是跨域共鸣发现器。给定来自 archetype <A> 的概念, ' +
    '在下方 candidates 里找 <k> 个出人意料的共鸣 (unexpected resonance), ' +
    '优先跨 archetype, 优先具体而非泛化, 优先能让学习者"啊!"一声而不是"嗯有点像"。\n' +
    '每条输出: {source_id, anchor (candidate 精确字句 max 60 chars), ' +
    'resonance_claim (中文 1-2 句, ≤120 chars), surprise_score (0.0-1.0)}.\n' +
    '严禁: 表面词汇匹配 / 概念抽象类比 / "都是关于...的" 空话.\n' +
    '输出 JSON: {sparks: [...]}';
  // 替换占位 <A> <k>
  const sys = system
    .replace('<A>', sourceArchetype || 'UNKNOWN')
    .replace('<k>', String(k));
  const user =
    `概念: ${concept}\n` +
    `来源 archetype: ${sourceArchetype || 'UNKNOWN'}\n` +
    `候选 (JSON): ${JSON.stringify(candidates, null, 0)}`;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: user },
  ];
}

// 容错 JSON 解析: dispatch.result 可能 (a) 已 parse 对象 (b) string + 围栏
function _coerceSparks(result) {
  if (!result) return null;
  let obj = result;
  if (typeof result === 'string') {
    // 剥围栏
    let s = result.trim();
    const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    if (fence) s = fence[1].trim();
    try { obj = JSON.parse(s); }
    catch (_) { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const arr = Array.isArray(obj.sparks) ? obj.sparks
            : Array.isArray(obj) ? obj
            : null;
  if (!arr) return null;
  // ensure shape
  return arr
    .filter(s => s && typeof s === 'object')
    .map(s => ({
      source_id:        String(s.source_id || ''),
      anchor:           String(s.anchor || '').slice(0, 60),
      resonance_claim:  String(s.resonance_claim || '').slice(0, 240),
      surprise_score:   (typeof s.surprise_score === 'number')
                          ? Math.max(0, Math.min(1, s.surprise_score))
                          : null,
    }))
    .filter(s => s.source_id && s.resonance_claim);
}

function _classifyLlmError(err) {
  // chain-exhausted 且首 attempt = AuthError => NO_LLM_KEY
  const msg = String((err && err.message) || '');
  if (/API_KEY not set/i.test(msg) || /auth failed/i.test(msg)) return 'NO_LLM_KEY';
  if (/All providers in .* failed/.test(msg) && /not set/i.test(msg)) return 'NO_LLM_KEY';
  return null;
}

async function generateCrossSparks({
  slug,
  concept,
  k = 3,
  dryRun = false,
  minStrength = MIN_STRENGTH_DEFAULT,
} = {}) {
  try {
    if (!concept || typeof concept !== 'string') {
      return { ok: false, error: 'EXCEPTION', message: 'concept required (non-empty string)' };
    }
    const vaultRoot = resolveRoot();

    // 1. source archetype
    let sourceArchetype = 'UNKNOWN';
    if (slug) {
      const stateAbs = path.join(vaultRoot, String(slug), 'state.json');
      if (fs.existsSync(stateAbs)) {
        try {
          const state = JSON.parse(_readText(stateAbs) || 'null');
          if (state && state.archetype) {
            sourceArchetype = String(state.archetype).toUpperCase();
          }
        } catch (_) { /* leave UNKNOWN */ }
      }
    }

    // 2. candidates
    const personas = _collectPersonaWisdom(vaultRoot);
    const otherLessons = _collectOtherLessons(vaultRoot, sourceArchetype);
    const candidates = _assembleCandidates(personas, otherLessons);
    if (candidates.length === 0) {
      return { ok: false, error: 'NO_CANDIDATES', candidatesUsed: 0 };
    }

    // 3. messages + LLM call
    const messages = _buildMessages({ concept, sourceArchetype, k, candidates });
    let dispatch;
    try {
      const { executeChat } = require('../llm');
      dispatch = await executeChat('T6_STRONG', {
        messages,
        json: true,
        maxTokens: 2000,
        temperature: 0.6,
      });
    } catch (err) {
      const code = _classifyLlmError(err);
      console.warn('[cross-spark] LLM call failed:', err && err.message);
      if (code === 'NO_LLM_KEY') {
        return { ok: false, error: 'NO_LLM_KEY', message: err.message };
      }
      return { ok: false, error: 'EXCEPTION', message: err && err.message };
    }

    const sparks = _coerceSparks(dispatch && dispatch.result);
    if (!sparks) {
      console.warn('[cross-spark] LLM_PARSE failed, raw result type=',
        typeof (dispatch && dispatch.result));
      return {
        ok: false,
        error: 'LLM_PARSE',
        candidatesUsed: candidates.length,
        llmAttempts: dispatch && dispatch.attempts,
      };
    }

    // Attach token-Jaccard strength per spark (concept ⋂ source snippet).
    // Survives gate `>= minStrength`; rejected count surfaced for callers.
    const candidateById = new Map(candidates.map(c => [c.source_id, c]));
    const threshold = (typeof minStrength === 'number' && minStrength >= 0 && minStrength <= 1)
      ? minStrength
      : MIN_STRENGTH_DEFAULT;
    const scored = sparks.map(s => {
      const cand = candidateById.get(s.source_id);
      const strength = cand
        ? Number(_computeStrength(concept, cand.snippet).toFixed(3))
        : 0;
      return { ...s, strength };
    });
    const accepted = scored.filter(s => s.strength >= threshold);
    const rejectedWeak = scored.length - accepted.length;

    // 4. persist (unless dryRun) — persist accepted only
    if (!dryRun && slug) {
      try {
        const sparksAbs = path.join(vaultRoot, String(slug), '.cross-sparks.jsonl');
        fs.mkdirSync(path.dirname(sparksAbs), { recursive: true });
        const row = {
          ts: new Date().toISOString(),
          concept,
          source_archetype: sourceArchetype,
          sparks: accepted,
        };
        fs.appendFileSync(sparksAbs, JSON.stringify(row) + '\n', 'utf-8');
      } catch (err) {
        // append 失败不影响返回 — sparks 已生成
        console.warn('[cross-spark] append jsonl failed:', err && err.message);
      }
    }

    return {
      ok: true,
      sparks: accepted,
      strengthGate: threshold,
      rejectedWeak,
      candidatesUsed: candidates.length,
      llmAttempts: (dispatch && dispatch.attempts) || 1,
    };
  } catch (err) {
    console.warn('[cross-spark] EXCEPTION:', err && err.stack);
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function listCrossSparks({ slug, limit = 50 } = {}) {
  try {
    if (!slug) return { ok: true, rows: [] };
    const vaultRoot = resolveRoot();
    const sparksAbs = path.join(vaultRoot, String(slug), '.cross-sparks.jsonl');
    if (!fs.existsSync(sparksAbs)) return { ok: true, rows: [] };
    const text = _readText(sparksAbs);
    if (!text) return { ok: true, rows: [] };
    const lines = text.split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const ln of lines) {
      try { rows.push(JSON.parse(ln)); } catch (_) { /* skip malformed */ }
    }
    rows.reverse();
    return { ok: true, rows: rows.slice(0, Math.max(1, limit)) };
  } catch (err) {
    console.warn('[cross-spark] listCrossSparks failed:', err && err.message);
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

module.exports = {
  generateCrossSparks,
  listCrossSparks,
  // exported for introspection / tests; not stable API
  _internals: {
    ARCHETYPES,
    MAX_CANDIDATES,
    MAX_PERSONA,
    MIN_STRENGTH_DEFAULT,
    collectPersonaWisdom: _collectPersonaWisdom,
    collectOtherLessons: _collectOtherLessons,
    assembleCandidates: _assembleCandidates,
    buildMessages: _buildMessages,
    coerceSparks: _coerceSparks,
    computeStrength: _computeStrength,
    tokenize: _tokenize,
  },
};
