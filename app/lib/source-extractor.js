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
// Cap: 50MB on disk, 1.5M characters extracted (anything beyond is truncated
// with a warning embedded in the last chapter).

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 50 * 1024 * 1024;
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
    throw new Error(`file too large (${Math.round(stat.size / 1024 / 1024)}MB > 50MB cap)`);
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

module.exports = { extractFromPath };
