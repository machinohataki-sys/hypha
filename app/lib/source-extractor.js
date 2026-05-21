// app/lib/source-extractor.js — extract text + chapter structure from a
// user-uploaded document (PDF / MD / TXT). Used by curriculum:create when the
// user supplies their own source corpus instead of the default web harvest.
//
// extractFromPath(filePath) → {
//   text:        full extracted text (string)
//   pageCount:   number (PDF only; 1 for MD/TXT)
//   fileName:    basename
//   ext:         lowercase extension without dot
//   chapters:    [{ title, text, startCharIdx }] — segmented for sources.json
// }
//
// 2026-05-05 — multi-file support added (Appendix B). Caps:
//   - per-file disk: 200 MB (was 50 MB) — bumped for textbooks/scanned PDFs
//   - per-file extracted text: 1.5 M chars (unchanged; truncate w/ warning)
//   - max files per upload: 8
//   - total disk: 800 MB
//   - total extracted text: 6 M chars
// All caps overridable via env vars (HYPHA_MAX_UPLOAD_MB, HYPHA_MAX_FILES,
// HYPHA_MAX_TOTAL_UPLOAD_MB, HYPHA_MAX_TOTAL_CHARS) for power users.
//
// _normalizeUploadedSource() lifts legacy single-file uploadedSource shape
// ({fileName, chapters[], ...}) into new multi-shape ({files:[...], totals})
// so old chains keep working without migration.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function _envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// 2026-05-18 user repro: Wonderbook (illustrated 213MB PDF) hit 200MB cap.
// Illustrated craft / reference PDFs commonly run 150-400MB. Bump default to
// 500MB (still safe — pdf-parse Buffer load is one-shot, extracted .txt is
// far smaller). User can still tighten via HYPHA_MAX_UPLOAD_MB env if low RAM.
const MAX_FILE_BYTES = _envInt('HYPHA_MAX_UPLOAD_MB', 500) * 1024 * 1024;
const MAX_FILES = _envInt('HYPHA_MAX_FILES', 8);
const MAX_TOTAL_BYTES = _envInt('HYPHA_MAX_TOTAL_UPLOAD_MB', 2000) * 1024 * 1024;
const MAX_TOTAL_CHARS = _envInt('HYPHA_MAX_TOTAL_CHARS', 6_000_000);
const MAX_TEXT_CHARS = 1_500_000;
const TARGET_CHUNK_CHARS = 6000;
// 2026-05-14 — TOC pages produce dense CHAPTER_RE matches with tiny gaps
// (30-200 chars of page-number-and-leader-dots between entries). Filter those
// out so phase 2 distill doesn't waste T6 tokens on un-extractable fragments.
const MIN_CHAPTER_CHARS = 300;

// Recognizes English/CJK chapter headings at line start. Tweaked for
// philosophy/biography/history books (Copleston, Munger Almanack, etc).
const CHAPTER_RE = /^(?:Chapter|CHAPTER|Part|PART|Book|第\s*[一二三四五六七八九十百千零0-9]+\s*[章部篇])\s+[\S].*$/m;

// Strip OCR'd page-number tails from chapter titles. Patterns seen in
// Copleston-series PDFs: `第四十章 晚期斯多亚学派.err 408`, `.ee 368`,
// `peereeeees 437`, trailing bare `437`. Heuristic only — keep CJK + the
// title prefix, drop the trailing page-leader noise.
function _cleanChapterTitle(title) {
  return String(title || '')
    // OCR garbage between title and page num: `.ee 368`, `.err 408`, `peereeeees 437`
    .replace(/[\.·• ]*[a-zA-Z]{1,12}[\.·• ]*\d{1,5}\s*$/, '')
    // OCR garbage with stray CJK glyph between latin + digits: `.ee人53`, `.er馬27`
    .replace(/[\.·•]\s*[a-zA-Z]{1,8}[一-鿿]{1,3}\d{1,5}\s*$/, '')
    // trailing bare page number alone (e.g. `第N章 X  437`)
    .replace(/[\s\.·•]+\d{2,5}\s*$/, '')
    // collapse runs of dots/middots used as leader dots
    .replace(/[\.·•]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _segmentByHeading(text, headingRe) {
  const matches = [];
  const re = new RegExp(headingRe.source, 'gm');
  let m;
  while ((m = re.exec(text)) !== null) {
    // Strip leading `#{1,6}\s+` so MD-extracted titles match PDF-extracted
    // titles (no hash prefix). Reader / SparkPack / Library cards all expect
    // a clean title — the prefix would render literally otherwise + break
    // skipTitle compare in the MD reader.
    const cleaned = m[0].replace(/^#{1,6}\s+/, '').trim().slice(0, 120);
    matches.push({ idx: m.index, title: cleaned });
  }
  if (matches.length === 0) return null;
  const raw = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : text.length;
    raw.push({
      title: _cleanChapterTitle(matches[i].title),
      text: text.slice(start, end).trim(),
      startCharIdx: start,
    });
  }
  // Filter tiny segments (TOC entries with leader-dot page refs). The Front
  // matter capture below stays exempt so the preface/TOC region still feeds
  // retrieval as one big chunk.
  let chapters = raw.filter(c => c.text.length >= MIN_CHAPTER_CHARS);
  // If filtering kills everything (highly irregular PDF), fall back to raw so
  // the caller's `chapters.length < 2` length-chunking branch still triggers.
  if (chapters.length === 0) chapters = raw;
  // Drop a leading "front matter" segment ONLY if matches[0].idx > 0 — capture
  // it as Chapter 0 so it still feeds into BM25 retrieval.
  if (matches[0].idx > 200) {
    chapters.unshift({
      title: 'Front matter',
      text: text.slice(0, matches[0].idx).trim(),
      startCharIdx: 0,
    });
  }
  return chapters;
}

function _segmentByLength(text, chunkSize = TARGET_CHUNK_CHARS) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    const slice = text.slice(i, i + chunkSize).trim();
    if (slice.length === 0) continue;
    chunks.push({
      title: `Section ${chunks.length + 1}`,
      text: slice,
      startCharIdx: i,
    });
  }
  return chunks;
}

async function _extractPdf(filePath, opts = {}) {
  // Lazy require — pdf-parse pulls in pdfjs-dist (~3MB), only load when used.
  const pdfParse = require('pdf-parse');
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  let text = String(data.text || '').replace(/\s+\n/g, '\n').trim();
  const pageCount = data.numpages || 1;

  // 2026-05-13 — auto-OCR fallback when pdf-parse returns empty text but the
  // PDF has pages (scan-only PDF, no text layer). Hypha bundles tesseract.js +
  // @napi-rs/canvas + pdfjs-dist v4 so the user never has to externally OCR.
  // First call downloads chi_sim + eng traineddata (~25MB) — net required once.
  if (text.length === 0 && pageCount > 0 && opts.allowOcr !== false) {
    try {
      const { ocrPdf } = require('./ocr');
      const ocrRes = await ocrPdf(filePath, {
        langs: opts.ocrLangs || 'chi_sim+eng',
        langPath: opts.ocrLangPath,    // CDN URL — Tesseract downloads from here
        cachePath: opts.ocrCachePath,  // local dir — downloads cached here after first fetch
        signal: opts.signal,
        onProgress: opts.onProgress,
      });
      text = String(ocrRes.text || '').trim();
    } catch (ocrErr) {
      // Bubble a clearer error than "no text" — tell the caller OCR was
      // attempted + why it failed so the UI can surface it directly.
      throw new Error(`OCR fallback failed: ${(ocrErr && ocrErr.message) || ocrErr}`);
    }
  }

  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[TRUNCATED — file exceeds extractor budget]';
  }
  return { text, pageCount };
}

function _extractMdOrTxt(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[TRUNCATED — file exceeds extractor budget]';
  }
  return { text, pageCount: 1 };
}

async function extractFromPath(filePath, opts = {}) {
  if (!filePath) throw new Error('no file path');
  let stat;
  try { stat = fs.statSync(filePath); }
  catch (err) { throw new Error(`file not found: ${err.message}`); }
  if (!stat.isFile()) throw new Error('path is not a file');
  if (stat.size > MAX_FILE_BYTES) {
    const capMB = Math.round(MAX_FILE_BYTES / 1024 / 1024);
    throw new Error(`file too large (${Math.round(stat.size / 1024 / 1024)}MB > ${capMB}MB cap)`);
  }
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const fileName = path.basename(filePath);

  // 2026-05-16 consolidation — α17 Book Router cache lookup. Hash file bytes,
  // probe vault/.book-router-cache/<sha>.text.md; on hit, re-segment + return
  // without re-running MarkItDown / pdf-parse. Cuts second-and-later
  // curriculum imports of the same source from minutes → milliseconds.
  let cachedSha = null;
  try {
    const buf = fs.readFileSync(filePath);
    cachedSha = crypto.createHash('sha256').update(buf).digest('hex');
    const bookRouter = require('./sources/book-router-cache');
    const hit = await bookRouter.lookupBySha256({ sha256: cachedSha });
    if (hit && hit.ok && hit.hit && typeof hit.extractedText === 'string' && hit.extractedText.length > 0) {
      let cachedText = hit.extractedText;
      if (cachedText.length > MAX_TEXT_CHARS) {
        cachedText = cachedText.slice(0, MAX_TEXT_CHARS) + '\n\n[TRUNCATED — file exceeds extractor budget]';
      }
      let cachedChapters = _segmentByHeading(cachedText, /^#{1,2}\s+.+$/m);
      if (!cachedChapters || cachedChapters.length < 2) {
        cachedChapters = _segmentByLength(cachedText);
      }
      // 2026-05-18 — surface parsedLevel='cached' so UI shows "cached" instead
      // of falling to 'unknown' fallback in library.js. Carries no attempts
      // (the original conversion that filled the cache is gone).
      return { text: cachedText, pageCount: 1, fileName, ext, chapters: cachedChapters, fromCache: true, parsedLevel: 'cached', attempts: [], sha256: cachedSha };
    }
  } catch (_) { /* cache best-effort — fall through to real extract */ }

  // 2026-05-18 — 4-level fallback orchestrator (per user lock "绝不报错").
  //   L1 native      JS in-process (epub via JSZip+turndown, pdf via pdf-parse)
  //   L2 markitdown  Microsoft markitdown via Python subprocess
  //   L3 raw-extract JSZip + cheerio strip (zip-based formats)
  //   L4 raw-stash   file copy + stub MD (last resort, always succeeds)
  // Result carries `level` enum so UI surfaces fidelity honestly.
  const _md = require('./markitdown-bridge');
  const _converter = require('./file-converter');
  let text, pageCount, parsedLevel;
  let attempts = [];
  if (_md.isNativeMd(ext)) {
    ({ text, pageCount } = _extractMdOrTxt(filePath));
    parsedLevel = 'native';  // direct MD read = effectively native
  } else {
    const conv = await _converter.convertFile(filePath, { onProgress: opts.onProgress });
    text = conv.mdText;
    parsedLevel = conv.level;
    attempts = conv.attempts || [];
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[TRUNCATED — file exceeds extractor budget]';
    }
    pageCount = (conv.stats && conv.stats.pages) || 1;
  }

  // MD-first segmentation: split on H1 / H2 headings. Fall back to length
  // chunks only if the file has no headings (rare for authored MD).
  let chapters = _segmentByHeading(text, /^#{1,2}\s+.+$/m);
  if (!chapters || chapters.length < 2) {
    chapters = _segmentByLength(text);
  }

  // 2026-05-16 consolidation — store extraction in α17 cache for next-time
  // lookup. Fire-and-forget so user creation never blocks on cache write.
  if (cachedSha) {
    try {
      const bookRouter = require('./sources/book-router-cache');
      Promise.resolve(bookRouter.storeExtraction({
        sha256: cachedSha,
        filename: fileName,
        sourceType: ext === 'pdf' ? 'pdf' : (ext === 'md' || ext === 'markdown' || ext === 'txt' ? 'markdown' : 'document'),
        mimeType: ext,
        byteSize: stat.size,
        extractedText: text,
        sourceMeta: { ext, pageCount, chapterCount: chapters.length },
      })).catch(() => { /* cache best-effort */ });
    } catch (_) { /* swallow */ }
  }

  return { text, pageCount, fileName, ext, chapters, parsedLevel, attempts, sha256: cachedSha };
}

// extractFromUrl(url) — fetch a webpage, extract main content, convert to
// chapter-shaped markdown for use as a user-supplied curriculum source.
// 2026-05-05 — uses already-bundled cheerio + node-fetch + turndown. No new
// deps. PDF URLs route through pdf-parse. YouTube URLs fall through the HTML
// path (cheerio of the watch page) which yields title + description; richer
// transcript extraction lives in agent.js's existing youtube-transcript
// channel and is not duplicated here.
// intentional-placeholder: rich YouTube transcript extraction stays in
// agent.js's harvest channel; this URL helper intentionally does not call
// youtube-transcript here to avoid a second code path that can drift.
//
// Returns same shape as extractFromPath: { text, pageCount, fileName, ext, chapters }.
// fileName = hostname + path slug (e.g. 'en.wikipedia.org_Vector_(mathematics)').
//
// Failure modes: network error, non-200 response, blocked-by-bot, JS-only SPA
// (cheerio sees empty body) → throw with reason. Caller decides to skip.
async function extractFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') throw new Error('no url');
  const url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('invalid url (must be http/https)');
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new Error('malformed url'); }
  // PDF URLs → fetch as binary, write to temp file, run pdf-parse
  const isPdf = /\.pdf(\?|#|$)/i.test(parsed.pathname);
  const fetchFn = require('node-fetch');
  if (isPdf) {
    const r = await fetchFn(url, { headers: { 'User-Agent': 'Hypha/0.3' }, redirect: 'follow' });
    if (!r.ok) throw new Error(`pdf url returned ${r.status}`);
    const buf = await r.buffer();
    if (buf.length > MAX_FILE_BYTES) throw new Error(`pdf too large (${Math.round(buf.length/1024/1024)}MB)`);
    const tmpPath = path.join(require('os').tmpdir(), `hypha-url-${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, buf);
    try {
      const result = await extractFromPath(tmpPath);
      const fileName = (parsed.hostname + parsed.pathname).replace(/[^\w.\-]+/g, '_').slice(0, 100);
      return { ...result, fileName: fileName || 'remote.pdf' };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
  // HTML → cheerio + turndown
  let cheerio, TurndownService;
  try { cheerio = require('cheerio'); } catch (_) { throw new Error('cheerio not installed'); }
  try { TurndownService = require('turndown'); } catch (_) { throw new Error('turndown not installed'); }
  const r = await Promise.race([
    fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Hypha/0.3)' }, redirect: 'follow' }),
    new Promise((_, rj) => setTimeout(() => rj(new Error('fetch timeout 12s')), 12_000)),
  ]);
  if (!r.ok) throw new Error(`url returned ${r.status}`);
  const html = await r.text();
  if (!html || html.length < 200) throw new Error('empty or near-empty response');
  const $ = cheerio.load(html);
  // Strip non-content noise
  $('script, style, nav, footer, header, aside, noscript, .nav, .footer, .header, .sidebar, .ads, .advertisement, iframe, form').remove();
  // Pick main content: prefer <main> / <article> / [role=main]; fall back to <body>.
  let mainEl = $('main').first();
  if (!mainEl || !mainEl.length) mainEl = $('article').first();
  if (!mainEl || !mainEl.length) mainEl = $('[role="main"]').first();
  if (!mainEl || !mainEl.length) mainEl = $('body');
  const mainHtml = mainEl.html() || '';
  if (!mainHtml.trim()) throw new Error('no main content extracted (likely SPA / JS-rendered)');
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  let text = td.turndown(mainHtml).trim();
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[TRUNCATED — exceeds extractor budget]';
  }
  // Segment by H1/H2 headings, fall back to length chunks (mirrors MD path).
  let chapters = _segmentByHeading(text, /^#{1,2}\s+.+$/m);
  if (!chapters || chapters.length < 2) chapters = _segmentByLength(text);
  const titleTag = $('title').first().text().trim();
  const fileName = (titleTag && titleTag.length < 80)
    ? titleTag
    : (parsed.hostname + parsed.pathname).replace(/[^\w.\-]+/g, '_').slice(0, 100) || 'remote.html';
  return { text, pageCount: 1, fileName, ext: 'html', chapters };
}

// _normalizeUploadedSource — adapter that lifts legacy single-file shape
// ({fileName, chapters[], text, ...}) into the new multi-file shape
// ({files: [...], totalChapters, totalPages, totalFiles}). Idempotent: if
// already multi-shape, returns unchanged. Returns null on falsy input.
//
// Call this at every consumer entry (chain:start, chain:advance,
// _runCurriculumCreate, etc.) so old chain meta keeps working.
function _normalizeUploadedSource(src) {
  if (!src) return null;
  if (Array.isArray(src.files)) return src;
  if (Array.isArray(src.chapters)) {
    return {
      files: [src],
      totalChapters: src.chapterCount || src.chapters.length || 0,
      totalPages: src.pageCount || 0,
      totalFiles: 1,
    };
  }
  return null;
}

// firstFileName — convenience getter that works on both legacy and new shapes.
// Used by event-log breadcrumbs / UI fallback strings.
function firstFileName(src) {
  if (!src) return null;
  if (Array.isArray(src.files) && src.files.length) return src.files[0].fileName || null;
  return src.fileName || null;
}

// extractWithLanePlan — optional lane-router dispatcher.
//
// When the caller supplies a `lanePlan` (from source-lane-router.routeLanes),
// dispatch a single URL to the layer-specific structured extractor:
//   - frontier  → source-conference-extractor (if URL host matches conference)
//   - canonical / pedagogy → source-course-extractor (if URL host matches course)
//   - anything else → fall back to extractFromUrl (text + chapters)
//
// Backward compat: callers that don't pass a `lanePlan` get the original
// extractFromUrl behavior via the standard extractFromUrl entry. This wrapper
// is purely additive — no existing caller is affected.
//
// @param {string} url
// @param {object} opts
// @param {object} [opts.lanePlan]  output of source-lane-router.routeLanes
// @param {string} [opts.html]      optional pre-fetched HTML (skip fetch)
// @returns {Promise<object>}  { ok, kind: 'conference'|'course'|'text', ...fields }
async function extractWithLanePlan(url, opts = {}) {
  if (!url || typeof url !== 'string') {
    return { ok: false, kind: 'invalid', reason: 'no url' };
  }
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { /* fall through */ }

  // Lazy require to avoid circular deps + keep cold-boot fast.
  const conferenceExtractor = require('./source-conference-extractor');
  const courseExtractor = require('./source-course-extractor');

  const isConference = conferenceExtractor._detectConferenceFromHost(url) !== null;
  const isCourse = courseExtractor._detectInstitution(url) !== null;

  // Caller may pre-fetch HTML (e.g. for synthetic fixtures or shared fetch).
  // If not provided, we currently DO NOT auto-fetch — this batch's contract
  // is "decision metadata + structured-field parser when given HTML". Real
  // network fetching stays in extractFromUrl until v0.3 harvest integration.
  if (typeof opts.html === 'string' && opts.html.length > 0) {
    if (isConference) {
      const r = conferenceExtractor.extractConferenceFields({ url, html: opts.html });
      return { ok: r.ok, kind: 'conference', ...r };
    }
    if (isCourse) {
      const r = courseExtractor.extractCourseFields({ url, html: opts.html });
      return { ok: r.ok, kind: 'course', ...r };
    }
    return {
      ok: false,
      kind: 'text',
      reason: `host ${host} did not match conference or course patterns; pass to extractFromUrl for plain text`,
    };
  }

  // No html supplied → defer to extractFromUrl (which fetches + parses to MD).
  // The kind is 'text'; structured-field extractors require explicit HTML.
  const r = await extractFromUrl(url);
  return { ok: true, kind: 'text', ...r };
}

module.exports = {
  extractFromPath,
  extractFromUrl,
  extractWithLanePlan,
  _normalizeUploadedSource,
  firstFileName,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  MAX_TOTAL_CHARS,
  MAX_TEXT_CHARS,
};
