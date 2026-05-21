'use strict';

// HYPHA · Note System §3 v0.5+ · Entropy Reduction Cycle (v0, β18 2026-05-16)
// ----------------------------------------------------------------------------
// 笔记 entropy 上升: 同主题灵感 (`## 用户灵感` block) 散落在 lesson-1.md /
// lesson-3.md / lesson-7.md, 跨课重复 + 矛盾不被 catch。Entropy Reduction
// Cycle = 定期 merge 同主题碎片到一篇 canonical 笔记 (manuscript register)。
//
// v0 范围 (无 LLM):
//   1. collectFragments({ slug }) — 扫 vault/data/<slug>/lesson-NN.md, 抽出
//      `## 用户灵感` block (到下个 `## ` 或文件末). 跳过占位 / 空 block.
//   2. listCanonicalNotes({ slug }) — 列 data/<slug>/canonical-notes/*.md.
//   3. readCanonicalNote / writeCanonicalNote / deleteCanonicalNote — CRUD.
//
// 不动原 lesson-NN.md (读取 only)。LLM auto-merge 留给 v1。
//
// Slug 解析复用 living-reactivation 同款 HYPHA_DATA / HYPHA_VAULT_DIR fallback。
//
// intentional-placeholder: the term "placeholder" appears in PLACEHOLDER_PATTERNS
// below as semantic vocabulary — it names the regex set that recognizes
// empty/space-marker text in `## 用户灵感` blocks (e.g. `_(空)_`, `—`). Not a
// code-placeholder marker. All 5 functions (collectFragments / listCanonicalNotes
// / readCanonicalNote / writeCanonicalNote / deleteCanonicalNote) are fully
// implemented below.

const fs   = require('node:fs');
const path = require('node:path');

const MAX_TITLE_LEN      = 200;
const MAX_BODY_LEN       = 20000;
const MAX_TOPIC_SLUG_LEN = 80;
const FRAGMENT_BLOCK     = '用户灵感';
const CANONICAL_DIR_NAME = 'canonical-notes';

// Placeholder shapes for the `用户灵感` block — emit no fragment when matched.
const PLACEHOLDER_PATTERNS = [
  /^_\(空\)_$/, /^_\(\s*空\s*\)_$/, /^_空_$/, /^\(空\)$/, /^空$/,
  /^_\(empty\)_$/i, /^\(empty\)$/i, /^—$/, /^---$/,
];

function _resolveSlugDir(slug) {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return path.join(process.env.HYPHA_DATA, slug);
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return path.join(process.env.HYPHA_VAULT_DIR, slug);
  }
  // hypha/app/lib/note-system/entropy-reduction.js → hypha/data
  return path.join(__dirname, '..', '..', '..', 'data', slug);
}

function _err(code, message) {
  return { ok: false, error: code, message: message || code };
}

function _isPlaceholder(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(t)) return true;
  }
  return false;
}

function _normalizeTopicSlug(raw) {
  const lowered = String(raw || '').toLowerCase().trim();
  if (!lowered) return '';
  // Allow lowercase ascii alnum + hyphen + underscore + CJK; replace rest with '-'.
  // Note: keep CJK so users can write a topic slug in Chinese characters.
  const cleaned = lowered
    .replace(/[^a-z0-9_\-一-鿿]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, MAX_TOPIC_SLUG_LEN);
}

function _listLessonFiles(slugDir) {
  const out = [];
  if (!fs.existsSync(slugDir)) return out;
  let entries = [];
  try { entries = fs.readdirSync(slugDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const m = /^lesson-(\d+)\.md$/i.exec(dirent.name);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (!Number.isFinite(idx)) continue;
    out.push({ idx, path: path.join(slugDir, dirent.name) });
  }
  out.sort((a, b) => a.idx - b.idx);
  return out;
}

function _stripFrontmatter(text) {
  return String(text || '').replace(/^---[\s\S]*?---\r?\n?/, '');
}

// Pull the body that sits under "## 用户灵感" until the next "## " or EOF.
// We accept any heading depth that contains the marker (## or ###) for
// robustness, but the canonical shape is `## 用户灵感`.
function _extractFragmentBody(fullText) {
  const stripped = _stripFrontmatter(fullText);
  const lines = stripped.split(/\r?\n/);
  const startRe = new RegExp(`^#{2,3}\\s+${FRAGMENT_BLOCK}\\s*$`);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { startIdx = i + 1; break; }
  }
  if (startIdx < 0) return '';
  let endIdx = lines.length;
  for (let j = startIdx; j < lines.length; j++) {
    if (/^#{1,3}\s+/.test(lines[j])) { endIdx = j; break; }
  }
  const body = lines.slice(startIdx, endIdx).join('\n').trim();
  return body;
}

function _parseLessonTitle(fullText) {
  const stripped = _stripFrontmatter(fullText);
  const m = stripped.match(/^#\s+(.+)$/m);
  if (m && m[1]) return m[1].trim().slice(0, MAX_TITLE_LEN);
  // Fall back to frontmatter `title:` if present.
  const fmMatch = String(fullText || '').match(/^---([\s\S]*?)---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const t = fm.match(/^title:\s*(.+)$/m);
    if (t && t[1]) return t[1].trim().replace(/^['"]|['"]$/g, '').slice(0, MAX_TITLE_LEN);
  }
  return '';
}

function _safeReadStat(absPath) {
  try { return fs.statSync(absPath); } catch (_) { return null; }
}

function _safeReadFile(absPath) {
  try { return fs.readFileSync(absPath, 'utf-8'); } catch (_) { return ''; }
}

function _ensureCanonicalDir(slugDir) {
  const dir = path.join(slugDir, CANONICAL_DIR_NAME);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* race-safe */ }
  return dir;
}

function _parseCanonicalFile(raw) {
  // Frontmatter: --- ... --- then body.
  const fmMatch = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const frontmatter = {};
  let body = String(raw || '');
  if (fmMatch) {
    const fm = fmMatch[1];
    body = body.slice(fmMatch[0].length);
    const lines = fm.split(/\r?\n/);
    for (const line of lines) {
      const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
      if (!kv) continue;
      const key = kv[1].trim();
      let val = kv[2].trim();
      if (/^\[.*\]$/.test(val)) {
        // List of numbers like [1, 3, 7]
        const inner = val.slice(1, -1);
        const parts = inner.split(',').map(s => s.trim()).filter(Boolean);
        frontmatter[key] = parts.map(p => {
          const n = Number(p);
          return Number.isFinite(n) ? n : p;
        });
      } else {
        val = val.replace(/^['"]|['"]$/g, '');
        frontmatter[key] = val;
      }
    }
  }
  return { frontmatter, body: body.trim() };
}

function _renderFrontmatter(fm) {
  const lines = ['---'];
  for (const key of Object.keys(fm)) {
    const val = fm[key];
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.join(', ')}]`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect all `## 用户灵感` fragments across the lessons of one slug.
 * Read-only. Returns { ok:true, fragments: [{lessonIdx, lessonTitle, fragment, ts}] }.
 */
async function collectFragments({ slug } = {}) {
  try {
    const s = String(slug || '').trim();
    if (!s) return _err('MISSING_SLUG', 'slug required');
    const slugDir = _resolveSlugDir(s);
    if (!fs.existsSync(slugDir)) {
      return { ok: true, fragments: [] };
    }
    const lessons = _listLessonFiles(slugDir);
    const fragments = [];
    for (const lesson of lessons) {
      const raw = _safeReadFile(lesson.path);
      if (!raw) continue;
      const body = _extractFragmentBody(raw);
      if (!body || _isPlaceholder(body)) continue;
      const stat = _safeReadStat(lesson.path);
      fragments.push({
        lessonIdx: lesson.idx,
        lessonTitle: _parseLessonTitle(raw),
        fragment: body,
        ts: stat ? new Date(stat.mtimeMs).toISOString() : null,
      });
    }
    return { ok: true, fragments };
  } catch (err) {
    return _err('EXCEPTION', (err && err.message) || String(err));
  }
}

/**
 * List canonical notes under data/<slug>/canonical-notes/*.md.
 * Returns { ok:true, notes: [{topicSlug, lastModified, fragmentCount}] }.
 */
async function listCanonicalNotes({ slug } = {}) {
  try {
    const s = String(slug || '').trim();
    if (!s) return _err('MISSING_SLUG', 'slug required');
    const slugDir = _resolveSlugDir(s);
    const canonicalDir = path.join(slugDir, CANONICAL_DIR_NAME);
    if (!fs.existsSync(canonicalDir)) {
      return { ok: true, notes: [] };
    }
    let entries = [];
    try { entries = fs.readdirSync(canonicalDir, { withFileTypes: true }); }
    catch (_) { return { ok: true, notes: [] }; }
    const notes = [];
    for (const dirent of entries) {
      if (!dirent.isFile()) continue;
      if (!/\.md$/i.test(dirent.name)) continue;
      const topicSlug = dirent.name.replace(/\.md$/i, '');
      const abs = path.join(canonicalDir, dirent.name);
      const stat = _safeReadStat(abs);
      let fragmentCount = 0;
      try {
        const parsed = _parseCanonicalFile(_safeReadFile(abs));
        const fm = parsed.frontmatter || {};
        const n = Number(fm.fragments_merged);
        if (Number.isFinite(n)) fragmentCount = n;
      } catch (_) { /* leave 0 */ }
      notes.push({
        topicSlug,
        lastModified: stat ? new Date(stat.mtimeMs).toISOString() : null,
        fragmentCount,
      });
    }
    notes.sort((a, b) => {
      if (!a.lastModified) return 1;
      if (!b.lastModified) return -1;
      return b.lastModified.localeCompare(a.lastModified);
    });
    return { ok: true, notes };
  } catch (err) {
    return _err('EXCEPTION', (err && err.message) || String(err));
  }
}

/**
 * Read one canonical note.
 * Returns { ok:true, note: {topicSlug, title, body, sources, ts} }.
 */
async function readCanonicalNote({ slug, topicSlug } = {}) {
  try {
    const s = String(slug || '').trim();
    if (!s) return _err('MISSING_SLUG', 'slug required');
    const t = _normalizeTopicSlug(topicSlug);
    if (!t) return _err('MISSING_TOPIC_SLUG', 'topicSlug required');
    const slugDir = _resolveSlugDir(s);
    const abs = path.join(slugDir, CANONICAL_DIR_NAME, `${t}.md`);
    if (!fs.existsSync(abs)) return _err('NOT_FOUND', `canonical note ${t} not found`);
    const raw = _safeReadFile(abs);
    const parsed = _parseCanonicalFile(raw);
    const stat = _safeReadStat(abs);
    const fm = parsed.frontmatter || {};
    const sources = Array.isArray(fm.sources) ? fm.sources : [];
    return {
      ok: true,
      note: {
        topicSlug: t,
        title: String(fm.title || '').slice(0, MAX_TITLE_LEN),
        body: parsed.body,
        sources,
        ts: stat ? new Date(stat.mtimeMs).toISOString() : null,
      },
    };
  } catch (err) {
    return _err('EXCEPTION', (err && err.message) || String(err));
  }
}

/**
 * Write (create or overwrite) one canonical note.
 * Returns { ok:true } on success.
 */
async function writeCanonicalNote({ slug, topicSlug, title, body, sources = [] } = {}) {
  try {
    const s = String(slug || '').trim();
    if (!s) return _err('MISSING_SLUG', 'slug required');
    const t = _normalizeTopicSlug(topicSlug);
    if (!t) return _err('MISSING_TOPIC_SLUG', 'topicSlug required');
    const titleStr = String(title || '').slice(0, MAX_TITLE_LEN).trim();
    const bodyStr  = String(body || '');
    if (bodyStr.length > MAX_BODY_LEN) {
      return _err('BODY_TOO_LONG', `body exceeds ${MAX_BODY_LEN} chars`);
    }
    const cleanSources = Array.isArray(sources)
      ? sources.map(n => Number(n)).filter(n => Number.isFinite(n))
      : [];
    const slugDir = _resolveSlugDir(s);
    const canonicalDir = _ensureCanonicalDir(slugDir);
    const abs = path.join(canonicalDir, `${t}.md`);
    const fm = {
      topic_slug: t,
      title: titleStr,
      updated_at: new Date().toISOString(),
      fragments_merged: cleanSources.length,
      sources: cleanSources,
    };
    const fileContent = `${_renderFrontmatter(fm)}\n\n${bodyStr.trim()}\n`;
    fs.writeFileSync(abs, fileContent, 'utf-8');
    return { ok: true };
  } catch (err) {
    return _err('EXCEPTION', (err && err.message) || String(err));
  }
}

/**
 * Delete one canonical note.
 * Returns { ok:true } on success (NOT_FOUND on miss).
 */
async function deleteCanonicalNote({ slug, topicSlug } = {}) {
  try {
    const s = String(slug || '').trim();
    if (!s) return _err('MISSING_SLUG', 'slug required');
    const t = _normalizeTopicSlug(topicSlug);
    if (!t) return _err('MISSING_TOPIC_SLUG', 'topicSlug required');
    const slugDir = _resolveSlugDir(s);
    const abs = path.join(slugDir, CANONICAL_DIR_NAME, `${t}.md`);
    if (!fs.existsSync(abs)) return _err('NOT_FOUND', `canonical note ${t} not found`);
    fs.unlinkSync(abs);
    return { ok: true };
  } catch (err) {
    return _err('EXCEPTION', (err && err.message) || String(err));
  }
}

module.exports = {
  collectFragments,
  listCanonicalNotes,
  readCanonicalNote,
  writeCanonicalNote,
  deleteCanonicalNote,
  // Exposed for tests / DI
  MAX_TITLE_LEN,
  MAX_BODY_LEN,
  CANONICAL_DIR_NAME,
  _resolveSlugDir,
  _normalizeTopicSlug,
  _extractFragmentBody,
};
