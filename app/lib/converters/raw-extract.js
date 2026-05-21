'use strict';
// HYPHA · raw-extract — last-ditch text extraction (L3 fallback).
//
// When L1 native + L2 markitdown both fail, try to salvage ANY text from the
// file. Strategy varies by ext:
//   .epub / .zip / .docx / .pptx → JSZip read internals, cheerio strip tags,
//                                  concat text. Loses ALL structure.
//   .pdf                          → already attempted in L1; L3 = ! supported.
//   .txt / .md / .csv             → read as plain text directly.
//   .html / .htm                  → cheerio strip + text.
//
// Output is NOT pretty markdown. Just text blobs. UI surfaces parsed_level
// === 'raw-extract' so user knows fidelity is degraded.

const fs = require('fs');
const path = require('path');

function _requireOpt(name) {
  try { return require(name); } catch (_) { return null; }
}

const JSZip = _requireOpt('jszip');
const cheerio = _requireOpt('cheerio');

/**
 * Best-effort text extraction. Always returns either ok:true or ok:false.
 *
 * @param {string} filePath  absolute path
 * @param {object} opts
 * @returns {Promise<{ok: true, mdText: string, level: 'raw-extract', stats: object} | {ok: false, reason: string}>}
 */
async function rawExtract(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'file not found' };

  const ext = path.extname(filePath).slice(1).toLowerCase();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const t0 = Date.now();

  // Plain-text formats — direct read
  if (ext === 'txt' || ext === 'md' || ext === 'markdown' || ext === 'csv' || ext === 'log') {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      if (!text.trim()) return { ok: false, reason: 'empty file' };
      return {
        ok: true,
        mdText: text.trim(),
        level: 'raw-extract',
        stats: { ms: Date.now() - t0, ext, total_chars: text.length, method: 'plain-read' },
      };
    } catch (err) {
      return { ok: false, reason: 'plain read failed: ' + ((err && err.message) || err) };
    }
  }

  // HTML — cheerio strip tags
  if ((ext === 'html' || ext === 'htm') && cheerio) {
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      const $ = cheerio.load(html);
      $('script, style, link, meta, head').remove();
      const text = $('body').text().replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) return { ok: false, reason: 'no text in HTML' };
      return {
        ok: true,
        mdText: text,
        level: 'raw-extract',
        stats: { ms: Date.now() - t0, ext, total_chars: text.length, method: 'cheerio-strip' },
      };
    } catch (err) {
      return { ok: false, reason: 'html strip failed: ' + ((err && err.message) || err) };
    }
  }

  // ZIP-based formats (EPUB, DOCX, PPTX, XLSX) — JSZip walk all xml/xhtml/htm
  // entries, cheerio strip, concat.
  if (['epub', 'zip', 'docx', 'pptx', 'xlsx', 'odt'].includes(ext)) {
    if (!JSZip || !cheerio) return { ok: false, reason: 'jszip + cheerio required for zip extract' };
    try {
      const buf = fs.readFileSync(filePath);
      const zip = await JSZip.loadAsync(buf);
      const fragments = [];
      const entries = Object.keys(zip.files);
      for (const name of entries) {
        const f = zip.files[name];
        if (f.dir) continue;
        const lname = name.toLowerCase();
        if (!(lname.endsWith('.xml') || lname.endsWith('.xhtml') || lname.endsWith('.html') || lname.endsWith('.htm') || lname.endsWith('.txt'))) continue;
        let content;
        try { content = await f.async('string'); } catch (_) { continue; }
        let stripped;
        try {
          const $ = cheerio.load(content, { xmlMode: lname.endsWith('.xml') });
          $('script, style, link, meta, head').remove();
          stripped = $.root().text().replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        } catch (_) {
          stripped = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        if (stripped) fragments.push(stripped);
      }
      if (fragments.length === 0) return { ok: false, reason: 'no readable text in zip' };
      const text = fragments.join('\n\n---\n\n');
      if (onProgress) onProgress({ stage: 'raw-extract-done', message: `raw-extract 完成 · ${fragments.length} 片段 · ${text.length} 字` });
      return {
        ok: true,
        mdText: text,
        level: 'raw-extract',
        stats: { ms: Date.now() - t0, ext, total_chars: text.length, fragments: fragments.length, method: 'zip-strip' },
      };
    } catch (err) {
      return { ok: false, reason: 'zip extract failed: ' + ((err && err.message) || err) };
    }
  }

  // Unrecognised → caller falls through to L4 raw-stash
  return { ok: false, reason: `ext .${ext} not supported by raw-extract` };
}

module.exports = { rawExtract };
