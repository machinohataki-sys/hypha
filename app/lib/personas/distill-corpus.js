'use strict';

// HYPHA · Persona Corpus Distillation (v0.5.1, per CLAUDE.md WHAT table:
// "Persona = 蒸馏当代专家 corpus, v0.5.1 待做")
//
// WHY: app/lib/personas.js stores 12 personas as single-string registers
// ("Teach like Karpathy: demystify ruthlessly..."). Surface mimicry only.
// Real persona fidelity needs structured wisdom extracted from primary
// corpus (interviews / letters / lectures / papers) — core beliefs,
// signature voice, thought patterns, anti-patterns, favorite referents,
// avoided topics, register, evidence provenance.
//
// HOW: distillPersonaCorpus({personaId, sourceTexts, settings, dryRun})
//   1. cap merged corpus at 30000 chars (head + tail split if longer)
//   2. call executeChat('T6_STRONG', {json:true, maxTokens:4000, temp:0.5})
//   3. system prompt forces structured JSON output (8 fields)
//   4. render markdown → vault/.persona-wisdom/<personaId>.md
//   5. dryRun=true skips disk write
//
// OUT OF SCOPE (per task brief):
//   - placeholder corpus files for 5 personas (β10 step)
//   - agent.js wisdom injection (γ10 step)
//   - automated corpus fetching (user supplies sourceTexts manually for MVP)
//
// CONVENTIONS:
//   - Uses capability-class router (executeChat) — DispatchPolicy + ProviderHealth
//   - No surgical edits to personas.js; string register stays
//   - Markdown frontmatter mirrors lesson-N.body.json convention (key: value pairs)
//   - Events appended to vault/events.jsonl for cross-cutting trace

const path = require('node:path');
const fs = require('node:fs');
const vault = require('../vault');

const SCHEMA_VERSION = '0.1';
const WISDOM_DIR = '.persona-wisdom';
const CORPUS_CAP_CHARS = 30000;
const HEAD_TAIL_HALF = 15000;
const MIN_CORPUS_CHARS = 3000;
const T6_MAX_TOKENS = 4000;
const T6_TEMPERATURE = 0.5;
const T6_TIMEOUT_MS = 90_000;

// ── Utility helpers ──────────────────────────────────────────────────────

function _appendEvent(op, payload) {
  try { vault.appendJSONL('events.jsonl', { ts: new Date().toISOString(), op, ...payload }); }
  catch (_) { /* best-effort */ }
}

function _joinSourceTexts(sourceTexts) {
  // Each entry rendered as: [LABEL] (source) \n text \n\n
  // Stable ordering preserves the caller's intent (most-important-first
  // already up to them).
  const blocks = sourceTexts.map((s, i) => {
    const label = String((s && s.label) || `片段 ${i + 1}`).trim();
    const source = String((s && s.source) || 'unknown').trim();
    const text = String((s && s.text) || '').trim();
    return `[${label}] (${source})\n${text}`;
  });
  return blocks.join('\n\n---\n\n');
}

function _capCorpus(text, cap = CORPUS_CAP_CHARS) {
  if (text.length <= cap) return text;
  // Head + tail strategy — keep both bookends, drop the middle. Less likely
  // to lose voice signature than naive head-only truncation.
  const head = text.slice(0, HEAD_TAIL_HALF);
  const tail = text.slice(text.length - HEAD_TAIL_HALF);
  return `${head}\n\n...[中段省略 ${text.length - cap} 字]...\n\n${tail}`;
}

function _safeId(personaId) {
  // Allow CJK + ascii alnum + hyphen + underscore. Reject path separators
  // so the markdown file can't escape the wisdom dir.
  const s = String(personaId || '').trim();
  if (!s) throw new Error('personaId required');
  if (s.includes('/') || s.includes('\\') || s.includes('..')) {
    throw new Error(`personaId contains forbidden chars: ${s}`);
  }
  return s;
}

function _todayIso() {
  return new Date().toISOString();
}

// Look up the current short register from personas.js for prompt context.
// Falls back to a generic stub if the personaId is not built-in (e.g. a
// custom persona being distilled).
function _lookupRegister(personaId) {
  try {
    const personas = require('../personas');
    const p = (personas && personas.PERSONAS || []).find(x => x && x.id === personaId);
    if (p && p.prompt) return p.prompt;
  } catch (_) { /* fall through */ }
  return '(无现成 register — 这是新蒸馏的 persona)';
}

// ── Prompt builders ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你在从原始 corpus 蒸馏一个人格的认知指纹。这不是仰慕,不是吹捧,是工程性提取。

任务: 给你 X 个原文片段 (访谈 / 论文 / 信件 / 主要作品段落),你要写出能让另一个 LLM 准确模仿这个人的"persona_wisdom"。

蒸馏维度 (输出 JSON):
- core_beliefs: 3-7 条,他对世界的根本判断
- signature_voice: 5-12 条,他写作中可识别的语言模式
- thought_patterns: 3-7 条,他思考的轨道 (从哪里出发,经过什么,落在哪里)
- anti_patterns: 3-7 条,他绝不会的事 (用作 negative steering)
- favorite_referents: 5-15 条,他常 anchor 到的具体事物
- topics_he_avoids: 2-5 条,他几乎不碰的话题
- register: 1-2 句整体调子
- source_provenance: 每个 wisdom 条目挂原文 ≤200 字 证据

规则:
- 不编造。每条 wisdom 必须能挂回原文证据
- 不浮夸。"他是 20 世纪最伟大的..." 是营销话,不是工程 distillation
- 写到 LLM 拿你这份 wisdom 能输出该 persona 的下一句话, 否则不够
- **输出强制中文** (core_beliefs / signature_voice / thought_patterns / anti_patterns / topics_he_avoids / register 全部字段)。
  例句 + 关键 referent 保留原语言 (Tolkien 英文 / Munger 英文 / Fosse 挪威译英 / 李沐中文 / Ernaux 法译中) — 但 wisdom 主体陈述句必须中文。
  即使 corpus 90% 英文, 你的输出 90% 必须中文 — 你是在为中文学习者建 persona prior, 不是把 corpus 翻译给英文读者。
- 不要 emoji,不要感叹号,不要 AI/LLM 等禁词

如果 corpus 太少 (< 3000 字) 或质量太差 (重复 / 翻译劣化 / 无信息密度),返回:
{"persona_id": ..., "skipped": "insufficient_corpus", "reason": "需要更多原文,当前 X 字"}

最终输出严格 JSON,key 顺序:
persona_id, schema_version, core_beliefs, signature_voice, thought_patterns,
anti_patterns, favorite_referents, topics_he_avoids, register, source_provenance.`;

function _buildUserPrompt({ personaId, currentRegister, totalChars, sourceTextsJoined }) {
  return `要蒸馏的 persona: ${personaId}
当前他在 personas.js 的简短 register: ${currentRegister}
今天日期: ${_todayIso()}

原文片段 (合并 ${totalChars} 字):
---
${sourceTextsJoined}
---

按上述 schema 输出 JSON。`;
}

// ── LLM call + JSON parsing ──────────────────────────────────────────────

function _extractContent(dispatch) {
  // Mirrors agent.js:designSkeletonOnly extraction logic (handles glm/deepseek/kimi shapes).
  const r = dispatch && dispatch.result;
  if (typeof r === 'string') return r;
  if (r && typeof r.content === 'string') return r.content;
  if (r && r.message && typeof r.message.content === 'string') return r.message.content;
  if (r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message
        && typeof r.choices[0].message.content === 'string') return r.choices[0].message.content;
  // executeChat 'json:true' sometimes returns the parsed object directly —
  // surface as JSON string for downstream JSON.parse() to round-trip cleanly.
  if (r && typeof r === 'object') return JSON.stringify(r);
  return '';
}

function _parseWisdom(raw, personaId) {
  if (!raw) throw new Error('empty LLM response');
  let obj = null;
  if (typeof raw === 'object') obj = raw;
  else {
    // Strip code fences if model wrapped JSON in ```json ... ```
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { obj = JSON.parse(cleaned); }
    catch (e) { throw new Error(`LLM returned non-JSON: ${e.message}`); }
  }
  if (!obj || typeof obj !== 'object') throw new Error('LLM returned non-object');
  // Patch persona_id + schema_version in case the model omitted them.
  if (!obj.persona_id) obj.persona_id = personaId;
  if (!obj.schema_version) obj.schema_version = SCHEMA_VERSION;
  return obj;
}

// ── Markdown rendering ───────────────────────────────────────────────────

function _renderList(items, fallback = '_(无)_') {
  if (!Array.isArray(items) || items.length === 0) return fallback;
  return items.map(it => {
    if (typeof it === 'string') return `- ${it.trim()}`;
    if (it && typeof it === 'object') {
      // Allow {text, example, source} or freeform shapes.
      const lines = [];
      const head = it.pattern || it.text || it.description || it.belief
        || it.wisdom_item || it.quote || it.evidence || it.claim || it.statement || '';
      if (head) lines.push(`- ${String(head).trim()}`);
      if (it.example) lines.push(`  - 例: ${String(it.example).trim()}`);
      if (it.source)  lines.push(`  - 来源: ${String(it.source).trim()}`);
      return lines.join('\n');
    }
    return `- ${String(it)}`;
  }).join('\n');
}

function _renderMarkdown(wisdom, meta) {
  const { personaId, distilledAt, sourceCount, totalChars } = meta;
  const lines = [];
  lines.push('---');
  lines.push(`persona_id: ${personaId}`);
  lines.push(`schema_version: ${wisdom.schema_version || SCHEMA_VERSION}`);
  lines.push(`distilled_at: ${distilledAt}`);
  lines.push(`source_count: ${sourceCount}`);
  lines.push(`total_chars: ${totalChars}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${personaId} · Persona Wisdom`);
  lines.push('');
  lines.push('> 由 source corpus 蒸馏。不是仰慕,是认知指纹。');
  lines.push('');
  lines.push('## 整体调子 (register)');
  lines.push(String(wisdom.register || '_(无)_').trim());
  lines.push('');
  lines.push('## 核心信念 (core_beliefs)');
  lines.push(_renderList(wisdom.core_beliefs));
  lines.push('');
  lines.push('## 标志性表达 (signature_voice)');
  lines.push(_renderList(wisdom.signature_voice));
  lines.push('');
  lines.push('## 思维模式 (thought_patterns)');
  lines.push(_renderList(wisdom.thought_patterns));
  lines.push('');
  lines.push('## 反模式 (anti_patterns)');
  lines.push(_renderList(wisdom.anti_patterns));
  lines.push('');
  lines.push('## 常用 referent (favorite_referents)');
  lines.push(_renderList(wisdom.favorite_referents));
  lines.push('');
  lines.push('## 不碰的话题 (topics_he_avoids)');
  lines.push(_renderList(wisdom.topics_he_avoids));
  lines.push('');
  lines.push('## 原文证据 (source_provenance)');
  lines.push(_renderList(wisdom.source_provenance));
  lines.push('');
  return lines.join('\n');
}

// ── Disk write ───────────────────────────────────────────────────────────

function _writeWisdomMarkdown(personaId, md) {
  // Place under vault root so user-side data layout stays consistent.
  // Bypasses vault.write's safeAbs (relative dotfile path under root); we
  // construct the absolute path explicitly to allow a dot-prefixed dir.
  const root = vault.resolveRoot();
  const dir = path.join(root, WISDOM_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* idempotent */ }
  const file = path.join(dir, `${personaId}.md`);
  fs.writeFileSync(file, md, 'utf8');
  // Return repo-relative path (forward slashes) for IPC ergonomics.
  return `${WISDOM_DIR}/${personaId}.md`;
}

function _readWisdomMarkdown(personaId) {
  const root = vault.resolveRoot();
  const file = path.join(root, WISDOM_DIR, `${personaId}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function _listWisdomFiles() {
  const root = vault.resolveRoot();
  const dir = path.join(root, WISDOM_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .map(name => {
      const id = name.replace(/\.md$/, '');
      const file = path.join(dir, name);
      let stat = null;
      try { stat = fs.statSync(file); } catch (_) {}
      return {
        persona_id: id,
        rel: `${WISDOM_DIR}/${name}`,
        modified_at: stat ? stat.mtime.toISOString() : null,
        size: stat ? stat.size : 0,
      };
    });
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Distill structured persona_wisdom from raw corpus snippets via T6_STRONG.
 *
 * @param {object}  args
 * @param {string}  args.personaId       e.g. 'tolkien' / 'nobel-literature-critic'
 * @param {Array<{source: 'url'|'file'|'transcript', label: string, text: string}>} args.sourceTexts
 * @param {object}  [args.settings]      reserved for future per-call overrides (currently unused — router reads env)
 * @param {boolean} [args.dryRun=false]  true → don't write the .md file, just return the wisdom object
 * @returns {Promise<{ok: boolean, wisdom?: object, mdPath?: string, skipped?: string, reason?: string, error?: string}>}
 */
async function distillPersonaCorpus({ personaId, sourceTexts, settings, dryRun = false } = {}) {
  // ── Input validation ───────────────────────────────────────────────────
  let safeId;
  try { safeId = _safeId(personaId); }
  catch (e) { return { ok: false, error: e.message }; }

  if (!Array.isArray(sourceTexts) || sourceTexts.length === 0) {
    return { ok: false, error: 'sourceTexts required (non-empty array)' };
  }
  for (let i = 0; i < sourceTexts.length; i++) {
    const s = sourceTexts[i];
    if (!s || typeof s !== 'object' || typeof s.text !== 'string') {
      return { ok: false, error: `sourceTexts[${i}] missing .text string` };
    }
  }

  // ── Build corpus block + char cap ──────────────────────────────────────
  const joined = _joinSourceTexts(sourceTexts);
  const capped = _capCorpus(joined);
  const totalChars = capped.length;

  // Local short-circuit on insufficient corpus — avoids burning a T6 call
  // when we already know it'll come back skipped. Saves ~5s + ~$0.005/run.
  if (joined.length < MIN_CORPUS_CHARS) {
    const out = {
      ok: true,
      skipped: 'insufficient_corpus',
      reason: `需要更多原文,当前 ${joined.length} 字 (< ${MIN_CORPUS_CHARS} 阈值)`,
      wisdom: {
        persona_id: safeId,
        schema_version: SCHEMA_VERSION,
        skipped: 'insufficient_corpus',
      },
    };
    _appendEvent('persona_distill_skipped', {
      persona_id: safeId, total_chars: joined.length, reason: out.reason,
    });
    return out;
  }

  // ── LLM dispatch ──────────────────────────────────────────────────────
  const currentRegister = _lookupRegister(safeId);
  const userPrompt = _buildUserPrompt({
    personaId: safeId,
    currentRegister,
    totalChars,
    sourceTextsJoined: capped,
  });

  let llm;
  try { llm = require('../llm'); }
  catch (e) { return { ok: false, error: `LLM module unavailable: ${e.message}` }; }
  if (!llm || typeof llm.executeChat !== 'function') {
    return { ok: false, error: 'executeChat unavailable (capability router not wired)' };
  }

  const t0 = Date.now();
  let dispatch = null;
  try {
    dispatch = await llm.executeChat('T6_STRONG', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt    },
      ],
      json: true,
      temperature: T6_TEMPERATURE,
      maxTokens: T6_MAX_TOKENS,
      timeoutMs: T6_TIMEOUT_MS,
    });
  } catch (e) {
    _appendEvent('persona_distill_error', {
      persona_id: safeId, total_chars: totalChars, error: e && e.message,
    });
    return { ok: false, error: `LLM call failed: ${e && e.message}` };
  }
  const latencyMs = Date.now() - t0;

  // ── Parse + post-process ──────────────────────────────────────────────
  const raw = _extractContent(dispatch);
  let wisdom;
  try { wisdom = _parseWisdom(raw, safeId); }
  catch (e) {
    _appendEvent('persona_distill_parse_error', {
      persona_id: safeId, latency_ms: latencyMs, error: e.message,
    });
    return { ok: false, error: e.message };
  }

  // LLM-side skip signal — surface without writing a markdown stub.
  if (wisdom.skipped === 'insufficient_corpus') {
    _appendEvent('persona_distill_skipped', {
      persona_id: safeId, total_chars: totalChars, reason: wisdom.reason || 'llm-side skip',
      provider: dispatch && dispatch.providerId, model: dispatch && dispatch.model,
    });
    return { ok: true, skipped: 'insufficient_corpus', reason: wisdom.reason || '', wisdom };
  }

  // ── Render + persist ──────────────────────────────────────────────────
  const distilledAt = _todayIso();
  const md = _renderMarkdown(wisdom, {
    personaId: safeId,
    distilledAt,
    sourceCount: sourceTexts.length,
    totalChars,
  });

  if (dryRun) {
    _appendEvent('persona_distill_dryrun', {
      persona_id: safeId, latency_ms: latencyMs, total_chars: totalChars,
      provider: dispatch && dispatch.providerId, model: dispatch && dispatch.model,
    });
    return { ok: true, wisdom, dryRun: true };
  }

  let mdPath;
  try { mdPath = _writeWisdomMarkdown(safeId, md); }
  catch (e) {
    _appendEvent('persona_distill_write_error', {
      persona_id: safeId, error: e.message,
    });
    return { ok: false, error: `write failed: ${e.message}`, wisdom };
  }

  _appendEvent('persona_distill_ok', {
    persona_id: safeId,
    latency_ms: latencyMs,
    total_chars: totalChars,
    source_count: sourceTexts.length,
    provider: dispatch && dispatch.providerId,
    model: dispatch && dispatch.model,
    md_path: mdPath,
  });

  return { ok: true, wisdom, mdPath };
}

/**
 * Returns the raw markdown for a previously-distilled persona, or null if
 * no wisdom file exists yet. Caller renders / parses as needed.
 *
 * @param {string} personaId
 * @returns {string|null}
 */
function getPersonaWisdom(personaId) {
  try {
    const safeId = _safeId(personaId);
    return _readWisdomMarkdown(safeId);
  } catch (_) { return null; }
}

/**
 * Lists all distilled persona wisdom files under vault/.persona-wisdom/.
 * @returns {Array<{persona_id: string, rel: string, modified_at: string|null, size: number}>}
 */
function listPersonaWisdom() {
  return _listWisdomFiles();
}

module.exports = {
  distillPersonaCorpus,
  getPersonaWisdom,
  listPersonaWisdom,
  // Exported for testing / introspection. Not part of stable public API.
  _internals: {
    SCHEMA_VERSION,
    WISDOM_DIR,
    CORPUS_CAP_CHARS,
    MIN_CORPUS_CHARS,
    SYSTEM_PROMPT,
    _capCorpus,
    _joinSourceTexts,
    _renderMarkdown,
    _parseWisdom,
  },
};
