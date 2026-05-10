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

function _envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const MAX_FILE_BYTES = _envInt('HYPHA_MAX_UPLOAD_MB', 200) * 1024 * 1024;
const MAX_FILES = _envInt('HYPHA_MAX_FILES', 8);
const MAX_TOTAL_BYTES = _envInt('HYPHA_MAX_TOTAL_UPLOAD_MB', 800) * 1024 * 1024;
const MAX_TOTAL_CHARS = _envInt('HYPHA_MAX_TOTAL_CHARS', 6_000_000);
const MAX_TEXT_CHARS = 1_500_000;
const TARGET_CHUNK_CHARS = 6000;

// Recognizes English/CJK chapter headings at line start. Tweaked for
// philosophy/biography/history books (Copleston, Munger Almanack, etc).
const CHAPTER_RE = /^(?:Chapter|CHAPTER|Part|PART|Book|第\s*[一二三四五六七八九十百千零0-9]+\s*[章部篇])\s+[\S].*$/m;

function _segmentByHeading(text, headingRe) {
  const matches = [];
  const re = new RegExp(headingRe.source, 'gm');
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ idx: m.index, title: m[0].trim().slice(0, 120) });
  }
  if (matches.length === 0) return null;
  const chapters = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].idx;
    const end = i + 1 < matches.length ? matches[i + 1].idx : text.length;
    chapters.push({
      title: matches[i].title,
      text: text.slice(start, end).trim(),
      startCharIdx: start,
    });
  }
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

async function _extractPdf(filePath) {
  // Lazy require — pdf-parse pulls in pdfjs-dist (~3MB), only load when used.
  const pdfParse = require('pdf-parse');
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  let text = String(data.text || '').replace(/\s+\n/g, '\n').trim();
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[TRUNCATED — file exceeds extractor budget]';
  }
  return { text, pageCount: data.numpages || 1 };
}

function _extractMdOrTxt(filePath) {
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[TRUNCATED — file exceeds extractor budget]';
  }
  return { text, pageCount: 1 };
}

async function extractFromPath(filePath) {
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

  let text, pageCount;
  if (ext === 'pdf') {
    ({ text, pageCount } = await _extractPdf(filePath));
  } else if (ext === 'md' || ext === 'markdown') {
    ({ text, pageCount } = _extractMdOrTxt(filePath));
  } else if (ext === 'txt') {
    ({ text, pageCount } = _extractMdOrTxt(filePath));
  } else {
    throw new Error(`unsupported extension: .${ext} (PDF, MD, TXT only)`);
  }

  // Segment into chapters. Strategy varies by extension:
  //   MD: split on H1 / H2 headings (most authored docs use these).
  //   PDF / TXT: try CHAPTER_RE; fall back to length-chunking if no hits.
  let chapters = null;
  if (ext === 'md' || ext === 'markdown') {
    chapters = _segmentByHeading(text, /^#{1,2}\s+.+$/m);
  }
  if (!chapters) {
    chapters = _segmentByHeading(text, CHAPTER_RE);
  }
  if (!chapters || chapters.length < 2) {
    chapters = _segmentByLength(text);
  }

  return { text, pageCount, fileName, ext, chapters };
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

module.exports = {
  extractFromPath,
  extractFromUrl,
  _normalizeUploadedSource,
  firstFileName,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  MAX_TOTAL_CHARS,
  MAX_TEXT_CHARS,
};
