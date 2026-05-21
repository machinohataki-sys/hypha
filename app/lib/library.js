'use strict';

// HYPHA · Library — user-uploaded knowledge source bibliography (System 5
// per BLUEPRINT: Bibliography Grounding + Library + Longform Distillation).
//
// Storage layout (vault.resolveRoot()):
//   data/library/<book-id>.json    book manifest (metadata + chunks)
//   data/library/<book-id>.txt     raw extracted text (for retrieval beyond chunks[])
//
// Each book.json:
//   {
//     id, title, author, type, added_at, source_file_name, page_count, char_count,
//     chunks: [{ idx, title, text, startCharIdx }]
//   }
//
// v0.1 retrieval = keyword scoring (title 3x + text 1x). Full BM25 + embed
// retrieval deferred to v0.6 (Cognitive Graph). The 蒸馏 dimension (Book
// Spark Pack, Longform Distillation) is a separate v0.5+ feature; this file
// handles 上传+存+取 only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { scoreFidelity } = require('./converters/fidelity-scorer');

const LIBRARY_SUBDIR = 'data/library';

// 2026-05-19 Phase 4 — per-process cache for getFidelity(). Library manifests
// are stable per session; same book_id queried N times per harvest call.
// Cleared explicitly via _clearFidelityCache() in tests.
const _FIDELITY_CACHE = new Map();
function _clearFidelityCache() { _FIDELITY_CACHE.clear(); }
const MAX_CHUNK_SNIPPET_CHARS = 800;
const DEFAULT_QUERY_K = 5;

// R-LIB v0.1 (2026-05-12) — Section-type classifier.
// Coarse regex over chunk text. 5 types informed by what KP narrative arc
// consumes downstream (per pedagogy.md Layer 4 Schema):
//   definition  → KP arc.definition       (opener match: "X 即/is defined as")
//   argument    → KP arc.derivation_chain (markers: therefore / 因此 / P1 P2)
//   critique    → KP arc.critique_of      (refutation: however / 但 / 反对)
//   biography   → low-value for KP        (year + life markers)
//   narrative   → fallback (everything else)
// Type-aware retrieval: lesson-body-generator boosts type=argument when
// generating derivation_chain, type=critique for critique_of, etc.
// Multilingual since user uploads 商务印书馆 中文译本 + 英文原版 alike.
const _SECTION_PATTERNS = {
  definition: [
    /\bis defined as\b/gi,
    /\bis a (?:type|kind|form|category) of\b/gi,
    /\brefers to\b/gi,
    /\bmeans (?:that|to)\b/gi,
    /\bby [A-Z]\w+(?: \w+){0,3} we mean\b/g,
    /[一-鿿]{1,12}(?:即|是指|意为|定义为)[一-鿿]/g,
    /所谓[一-鿿]{1,12}(?:[，,。.])/g,
    /[一-鿿]{1,12}的定义[是：:]/g,
  ],
  argument: [
    /\b(?:therefore|hence|thus|ergo|q\.?e\.?d\.?)\b/gi,
    /\b(?:premise|conclusion|it follows that)\b/gi,
    /\bP[12345]\)/g,
    /\bC\)\s*[A-Z]/g,
    /(?:因此|所以|故|由此可知|由此推出|从而|进而)/g,
    /(?:前提|结论|推论)[一二三四五六七八九十]?[:：]/g,
  ],
  critique: [
    /\b(?:however|but|yet|nonetheless|contra|on the contrary)\b/gi,
    /\b(?:objects?|objection|rejects?|refutes?|disputes?|criticizes?|opposes?)\b/gi,
    /\b(?:argues against|stands against|takes issue with)\b/gi,
    /(?:但是|然而|不过|反之|可是)/g,
    /(?:反对|驳斥|批判|质疑|反驳|抨击)/g,
  ],
  biography: [
    /\(\s*\d{3,4}\s*[-–—]\s*\d{3,4}\s*\)/g,
    /\b(?:born|died)\s+(?:in\s+)?\d{3,4}/gi,
    /(?:生于|卒于|出生于|逝于|享年|时年)\s*[一二三四五六七八九十百零0-9]+\s*岁?年?/g,
    /公元前?\s*\d+\s*年/g,
  ],
};

function _scoreSectionType(text) {
  if (!text || typeof text !== 'string') return 'narrative';
  const tl = text.length;
  if (tl < 60) return 'narrative';
  const scores = {};
  for (const [type, patterns] of Object.entries(_SECTION_PATTERNS)) {
    let s = 0;
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) s += m.length;
    }
    // Density per 1000 chars — prevents long chunks dominating short ones
    scores[type] = (s / Math.max(1, tl)) * 1000;
  }
  let bestType = 'narrative';
  let bestScore = 0;
  for (const [t, s] of Object.entries(scores)) {
    if (s > bestScore) { bestScore = s; bestType = t; }
  }
  // Threshold = 0.3 hits per 1000 chars → narrative if too sparse
  return bestScore >= 0.3 ? bestType : 'narrative';
}

function _ensureDir(absDir) {
  try { fs.mkdirSync(absDir, { recursive: true }); } catch (_) {}
}

function _libraryDir(vaultRoot) {
  return path.join(vaultRoot, LIBRARY_SUBDIR);
}

// Phase G.3 (2026-05-18) — content dedup helper. Walks all *.json in
// library dir, returns first manifest whose source_sha256 matches. Returns
// null if no match. Best-effort: parse failures on individual manifests
// are skipped (don't kill the whole probe).
function _findBySha256({ vaultRoot, sha256 }) {
  if (!sha256 || !vaultRoot) return null;
  const dir = _libraryDir(vaultRoot);
  if (!fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return null; }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (m && m.source_sha256 === sha256) return m;
    } catch (_) { /* skip malformed manifest */ }
  }
  return null;
}

function _genBookId(fileName) {
  const seed = `${fileName}::${Date.now()}::${Math.random()}`;
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

function _safeReadJSON(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function _bookManifestPath(vaultRoot, id) {
  return path.join(_libraryDir(vaultRoot), id + '.json');
}

function _bookTextPath(vaultRoot, id) {
  return path.join(_libraryDir(vaultRoot), id + '.txt');
}

/**
 * List all books in the library. Returns metadata only (no chunks/text).
 *
 * @param {string} vaultRoot
 * @returns {Array<{id,title,author,type,added_at,source_file_name,page_count,char_count,chunk_count}>}
 */
function listBooks(vaultRoot) {
  const dir = _libraryDir(vaultRoot);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const manifest = _safeReadJSON(path.join(dir, ent.name));
    if (!manifest || !manifest.id) continue;
    out.push({
      id: manifest.id,
      title: manifest.title,
      author: manifest.author,
      type: manifest.type,
      added_at: manifest.added_at,
      source_file_name: manifest.source_file_name,
      page_count: manifest.page_count,
      char_count: manifest.char_count,
      chunk_count: Array.isArray(manifest.chunks) ? manifest.chunks.length : 0,
      // 2026-05-18 Bug C fix — surface fidelity level + content fingerprint
      // for Library Shelf UI to render badge + future dedup operations.
      parsed_level: manifest.parsed_level || 'unknown',
      source_sha256: manifest.source_sha256 || null,
      // 2026-05-19 Phase 4 — fidelity score (HYPHA-MD-SPEC compliance + content
      // heuristic 0-1). Library Shelf renders tier badge; lesson-body-generator
      // reads to inject confession when < 0.7. Per Anti-Slop bridge plan.
      fidelity_score: typeof manifest.fidelity_score === 'number' ? manifest.fidelity_score : null,
      fidelity_tier: manifest.fidelity_tier || null,
    });
  }
  out.sort((a, b) => String(b.added_at || '').localeCompare(String(a.added_at || '')));
  return out;
}

/**
 * Add a book — extract via source-extractor + persist manifest + raw text.
 *
 * @param {object} args
 * @param {string} args.vaultRoot
 * @param {string} args.filePath   absolute path to PDF/MD/TXT
 * @param {string} args.title?     optional override (default: derived from filename)
 * @param {string} args.author?    optional
 * @returns {{ok, book?, error?}}
 */
async function addBook({ vaultRoot, filePath, title, author, ocrLangPath, ocrCachePath, ocrLangs, onProgress, signal }) {
  if (!vaultRoot || !filePath) return { ok: false, error: 'vaultRoot + filePath required' };
  if (!fs.existsSync(filePath)) return { ok: false, error: 'file not found: ' + filePath };

  const sourceExtractor = require('./source-extractor');
  let extracted;
  try {
    extracted = await sourceExtractor.extractFromPath(filePath, {
      ocrLangPath,
      ocrCachePath,
      ocrLangs: ocrLangs || 'chi_sim+eng',
      signal,
      onProgress,
    });
  } catch (e) {
    return { ok: false, error: 'extract failed: ' + (e && e.message) };
  }
  // Phase G.3 (2026-05-18) — content-SHA dedup. If a prior book has matching
  // source_sha256 in its manifest, return that existing book.id instead of
  // creating a new manifest. Prevents N copies of the same EPUB from N upload
  // attempts. Forward-compat: manifests without source_sha256 are skipped in
  // the comparison (no false-positive dedup against pre-G.3 books).
  if (extracted && extracted.sha256) {
    try {
      const existing = _findBySha256({ vaultRoot, sha256: extracted.sha256 });
      if (existing) {
        if (typeof onProgress === 'function') {
          try { onProgress({ stage: 'dedup-hit', message: `内容指纹命中: ${existing.title} — 跳过重写, 复用现有 manifest` }); } catch (_) {}
        }
        return { ok: true, book: { ...existing, chunk_count: Array.isArray(existing.chunks) ? existing.chunks.length : 0, chunks: undefined, deduped: true } };
      }
    } catch (_) { /* dedup probe best-effort */ }
  }

  // 2026-05-18 — OCR auto-fallback shipped in native-pdf.js, so scan-only PDFs
  // now usually succeed via L1 OCR path (parsedLevel='ocr'). Only surface the
  // scan-only guidance when:
  //   - PDF ext
  //   - all 4 levels FAILED to extract text (parsedLevel='raw-stash')
  //   - AND OCR was either skipped OR returned empty (attempts[].reason mentions OCR)
  // i.e. truly unrecoverable scan PDF — tell user to pre-process externally.
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'pdf' && extracted && extracted.parsedLevel === 'raw-stash' && Array.isArray(extracted.attempts)) {
    const ocrAttemptedAndFailed = extracted.attempts.find(a =>
      a && a.reason && /OCR returned empty|OCR fallback failed/i.test(String(a.reason))
    );
    const emptyAndNoOcr = extracted.attempts.find(a =>
      a && a.reason && /empty text|image-only|empty output/i.test(String(a.reason))
    );
    if (ocrAttemptedAndFailed || emptyAndNoOcr) {
      return {
        ok: false,
        error: 'scan-only PDF — 内置 OCR 也未能提取. 试用更强外部工具: ' +
               '(a) pip install ocrmypdf + Tesseract → ocrmypdf "in.pdf" "out.pdf" -l chi_sim+eng; ' +
               '(b) Adobe Acrobat → 工具 > 增强扫描 > OCR; ' +
               '(c) ABBYY FineReader. 然后上传处理后的版本.',
      };
    }
  }

  if (!extracted || !extracted.text || extracted.text.trim().length === 0) {
    // Distinguish scan-only PDF (has pages but no text layer — needs OCR) vs
    // genuinely empty / corrupt file. pdf-parse on a scanned PDF returns
    // empty .text + non-zero .pageCount. Surface OCR guidance specifically
    // because Z-Library + 1990s 商务印书馆 中文古典哲学 PDF 几乎全是扫描版.
    if (extracted && (extracted.pageCount || 0) > 0) {
      return {
        ok: false,
        error: `scan-only PDF detected (${extracted.pageCount} 页, 无文字层). Hypha 当前不内置 OCR. ` +
               `先用 OCR 工具转成可搜索 PDF: (a) pip install ocrmypdf + Tesseract → ` +
               `ocrmypdf "in.pdf" "out.pdf" -l chi_sim+eng; (b) Adobe Acrobat → 工具 > 增强扫描 > OCR; ` +
               `(c) ABBYY FineReader. 然后上传 OCR 后的版本.`,
      };
    }
    return { ok: false, error: 'no text extracted — file may be empty, corrupt, or password-protected' };
  }

  const id = _genBookId(extracted.fileName || path.basename(filePath));
  const dir = _libraryDir(vaultRoot);
  _ensureDir(dir);

  const chunks = Array.isArray(extracted.chapters) && extracted.chapters.length > 0
    ? extracted.chapters.map((c, idx) => ({
        idx,
        title: c.title || `Section ${idx + 1}`,
        text: c.text || '',
        startCharIdx: c.startCharIdx || 0,
        type: _scoreSectionType(c.text || ''),
      }))
    // No chapter structure detected — emit one chunk wrapping the whole text.
    : [{ idx: 0, title: 'Full text', text: extracted.text, startCharIdx: 0, type: _scoreSectionType(extracted.text) }];

  // 2026-05-19 Phase 4 — Anti-Slop bridge: compute fidelity score from the
  // converted text body. Persists to manifest so downstream (Library Shelf
  // badge, lesson-body-generator confession injection, Course Trust Panel
  // source-fidelity row) can read without re-scoring. Cheap (~5ms for 200KB).
  let fidelity = null;
  try {
    fidelity = scoreFidelity({
      mdText: extracted.text,
      ext: (extracted.ext || path.extname(filePath).slice(1) || '').toLowerCase(),
      expected_pages: extracted.pageCount || undefined,
      parsed_level: extracted.parsedLevel || 'unknown',
    });
  } catch (_) { /* scorer best-effort; manifest still writes without */ }

  const manifest = {
    id,
    title: (title && title.trim()) || _titleFromFileName(extracted.fileName || path.basename(filePath)),
    author: (author && author.trim()) || '',
    type: (extracted.ext || path.extname(filePath).slice(1) || '').toLowerCase(),
    added_at: new Date().toISOString(),
    source_file_name: extracted.fileName || path.basename(filePath),
    page_count: extracted.pageCount || 0,
    char_count: extracted.text.length,
    // 2026-05-18 — 4-level converter chain surfaces fidelity honestly.
    parsed_level: extracted.parsedLevel || 'unknown',  // native | markitdown | raw-extract | raw-stash | cached
    parse_attempts: Array.isArray(extracted.attempts) ? extracted.attempts : [],
    // Phase G.3 — content fingerprint for dedup on re-upload.
    source_sha256: extracted.sha256 || null,
    // 2026-05-19 Phase 4 — fidelity score (0-1) + tier (high/mid/low) + full
    // breakdown for debugging. Persists per HYPHA-MD-SPEC v1.
    fidelity_score: fidelity ? fidelity.score : null,
    fidelity_tier: fidelity ? fidelity.tier : null,
    fidelity_breakdown: fidelity ? fidelity.breakdown : null,
    chunks,
  };

  try {
    fs.writeFileSync(_bookManifestPath(vaultRoot, id), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(_bookTextPath(vaultRoot, id), extracted.text, 'utf8');
  } catch (e) {
    return { ok: false, error: 'write failed: ' + (e && e.message) };
  }

  return { ok: true, book: { ...manifest, chunks: undefined, chunk_count: chunks.length, parsed_level: manifest.parsed_level, fidelity_score: manifest.fidelity_score, fidelity_tier: manifest.fidelity_tier } };
}

/**
 * Read fidelity score from a book's manifest. Cached per-process.
 * 2026-05-19 Phase 4 Anti-Slop bridge: agent.js source-build sites enrich
 * rankedSources with this so lesson-body-generator can render fidelity tags
 * + downstream confession layer can warn user about low-fidelity grounding.
 *
 * @param {{vaultRoot:string, bookId:string}} args
 * @returns {{fidelity_score:number|null, fidelity_tier:string|null, parsed_level:string|null} | null}
 */
function getFidelity({ vaultRoot, bookId }) {
  if (!vaultRoot || !bookId) return null;
  const key = `${vaultRoot}::${bookId}`;
  if (_FIDELITY_CACHE.has(key)) return _FIDELITY_CACHE.get(key);
  try {
    const manifestPath = _bookManifestPath(vaultRoot, bookId);
    if (!fs.existsSync(manifestPath)) {
      _FIDELITY_CACHE.set(key, null);
      return null;
    }
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const fid = {
      fidelity_score: typeof m.fidelity_score === 'number' ? m.fidelity_score : null,
      fidelity_tier: m.fidelity_tier || null,
      parsed_level: m.parsed_level || null,
    };
    _FIDELITY_CACHE.set(key, fid);
    return fid;
  } catch (_) {
    _FIDELITY_CACHE.set(key, null);
    return null;
  }
}

function _titleFromFileName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || name;
}

/**
 * Remove a book — delete manifest + text. Returns { ok }.
 */
function removeBook({ vaultRoot, id }) {
  if (!vaultRoot || !id) return { ok: false, error: 'vaultRoot + id required' };
  const m = _bookManifestPath(vaultRoot, id);
  const t = _bookTextPath(vaultRoot, id);
  try { if (fs.existsSync(m)) fs.unlinkSync(m); } catch (_) {}
  try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch (_) {}
  return { ok: true };
}

/**
 * Read a single book's full manifest (including all chunks).
 */
function getBook({ vaultRoot, id }) {
  if (!vaultRoot || !id) return { ok: false, error: 'vaultRoot + id required' };
  const manifest = _safeReadJSON(_bookManifestPath(vaultRoot, id));
  if (!manifest) return { ok: false, error: 'book not found' };
  return { ok: true, book: manifest };
}

/**
 * Query library — return top-K chunks across all books relevant to topic.
 *
 * v0.1: keyword scoring. Tokenize topic (lowercase + CJK char split + whitespace
 * split). For each chunk: title matches weighted 3x, text matches 1x.
 * Threshold = score > 0. Returns at most K results with snippet (~MAX_CHUNK_SNIPPET_CHARS).
 *
 * @param {string} vaultRoot
 * @param {string} topic
 * @param {number} k
 * @returns {Array<{book_id, book_title, book_author, chunk_idx, chunk_title, snippet, score}>}
 */
function queryLibrary({ vaultRoot, topic, k }) {
  if (!vaultRoot || !topic) return [];
  const kCap = Number.isFinite(k) && k > 0 ? k : DEFAULT_QUERY_K;
  const tokens = _tokenize(topic);
  if (tokens.length === 0) return [];

  const dir = _libraryDir(vaultRoot);
  if (!fs.existsSync(dir)) return [];

  const candidates = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    const manifest = _safeReadJSON(path.join(dir, ent.name));
    if (!manifest || !Array.isArray(manifest.chunks)) continue;
    for (const ch of manifest.chunks) {
      const score = _scoreChunk(ch, tokens);
      if (score > 0) {
        candidates.push({
          book_id: manifest.id,
          book_title: manifest.title,
          book_author: manifest.author,
          chunk_idx: ch.idx,
          chunk_title: ch.title,
          chunk_type: ch.type || null,
          snippet: (ch.text || '').slice(0, MAX_CHUNK_SNIPPET_CHARS),
          score,
        });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, kCap);
}

function _tokenize(s) {
  const lower = String(s || '').toLowerCase();
  // Whitespace + punctuation split for ASCII, then add CJK chars individually
  // (cheap n-gram-ish for Chinese without segmenter dependency).
  const ascii = lower.match(/[a-z0-9]{2,}/g) || [];
  const cjk = (lower.match(/[一-鿿]/g) || []);
  return [...new Set([...ascii, ...cjk])];
}

function _scoreChunk(ch, tokens) {
  const title = String(ch.title || '').toLowerCase();
  const text = String(ch.text || '').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    // Title matches weighted heavier (chapter headings = strong topical anchor)
    let titleCount = 0;
    let pos = title.indexOf(t);
    while (pos !== -1) { titleCount++; pos = title.indexOf(t, pos + 1); }
    score += titleCount * 3;
    // Text matches — capped per-token at 50 to prevent one chunk dominating
    let textCount = 0;
    pos = text.indexOf(t);
    while (pos !== -1 && textCount < 50) { textCount++; pos = text.indexOf(t, pos + 1); }
    score += textCount;
  }
  return score;
}

/**
 * Get a single book's table of contents — chapter titles only, no body text.
 * Used by harvest skeleton stage to surface "Copleston Vol 4 has 8 sections
 * on Spinoza" structure into prompt without inflating token budget.
 *
 * @param {object} args
 * @param {string} args.vaultRoot
 * @param {string} args.id
 * @returns {{ok, toc?: [{idx, title, type}], book?: {id, title, author, page_count}, error?}}
 */
function getBookTOC({ vaultRoot, id }) {
  if (!vaultRoot || !id) return { ok: false, error: 'vaultRoot + id required' };
  const manifest = _safeReadJSON(_bookManifestPath(vaultRoot, id));
  if (!manifest) return { ok: false, error: 'book not found' };
  const toc = Array.isArray(manifest.chunks)
    ? manifest.chunks.map(ch => ({
        idx: ch.idx,
        title: ch.title || `Section ${ch.idx + 1}`,
        type: ch.type || null,
      }))
    : [];
  return {
    ok: true,
    book: {
      id: manifest.id,
      title: manifest.title,
      author: manifest.author,
      page_count: manifest.page_count || 0,
    },
    toc,
  };
}

/**
 * Backfill section types for existing books that lack chunk.type field.
 * Idempotent — only rewrites manifest if at least 1 chunk needs type added.
 * Called at app startup (R-LIB Day 1) so pre-classifier books get type tags
 * without re-uploading.
 *
 * @param {string} vaultRoot
 * @returns {{ scanned, updated, errors }}
 */
function backfillSectionTypes(vaultRoot) {
  if (!vaultRoot) return { scanned: 0, updated: 0, errors: 0 };
  const dir = _libraryDir(vaultRoot);
  if (!fs.existsSync(dir)) return { scanned: 0, updated: 0, errors: 0 };
  let scanned = 0, updated = 0, errors = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    scanned++;
    const manifestPath = path.join(dir, ent.name);
    const manifest = _safeReadJSON(manifestPath);
    if (!manifest || !Array.isArray(manifest.chunks)) continue;
    let dirty = false;
    for (const ch of manifest.chunks) {
      if (!ch.type) {
        ch.type = _scoreSectionType(ch.text || '');
        dirty = true;
      }
    }
    if (dirty) {
      try {
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        updated++;
      } catch (_) {
        errors++;
      }
    }
  }
  return { scanned, updated, errors };
}

/**
 * Backfill fidelity_score for existing manifests that pre-date the scorer ship.
 * Reads .txt sidecar, runs scoreFidelity, writes fields to manifest.
 *
 * @param {string} vaultRoot
 * @returns {{ scanned:number, scored:number, skipped:number, errors:number }}
 */
function backfillFidelity(vaultRoot) {
  if (!vaultRoot) return { scanned: 0, scored: 0, skipped: 0, errors: 0 };
  const dir = _libraryDir(vaultRoot);
  if (!fs.existsSync(dir)) return { scanned: 0, scored: 0, skipped: 0, errors: 0 };
  let scanned = 0, scored = 0, skipped = 0, errors = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    scanned++;
    const manifestPath = path.join(dir, ent.name);
    const manifest = _safeReadJSON(manifestPath);
    if (!manifest || !manifest.id) { errors++; continue; }
    if (typeof manifest.fidelity_score === 'number') { skipped++; continue; }
    const textPath = _bookTextPath(vaultRoot, manifest.id);
    if (!fs.existsSync(textPath)) { errors++; continue; }
    try {
      const text = fs.readFileSync(textPath, 'utf8');
      const fid = scoreFidelity({
        mdText: text,
        ext: manifest.type || 'unknown',
        expected_pages: manifest.page_count || undefined,
        parsed_level: manifest.parsed_level || 'unknown',
      });
      manifest.fidelity_score = fid.score;
      manifest.fidelity_tier = fid.tier;
      manifest.fidelity_breakdown = fid.breakdown;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      scored++;
    } catch (_) {
      errors++;
    }
  }
  _clearFidelityCache();
  return { scanned, scored, skipped, errors };
}

module.exports = {
  listBooks,
  addBook,
  removeBook,
  getBook,
  getBookTOC,
  queryLibrary,
  backfillSectionTypes,
  backfillFidelity,
  getFidelity,
  _clearFidelityCache,
  classifyChunk: _scoreSectionType,
};
