'use strict';
// HYPHA · native-pdf — fast PDF→text via pdf-parse (already installed).
//
// Fidelity: extracts text per page. Loses layout (multi-column collapses),
// formulas (rendered as garbled), images (skipped). Good for text-heavy
// academic / literary PDFs; markitdown via mistune is better for tables.
//
// Decision: try this first as L1 native; markitdown picks up if pdf-parse
// returns empty (image-only PDF, scanned without OCR layer).

const fs = require('fs');

function _requireOpt(name) {
  try { return require(name); } catch (_) { return null; }
}

const pdfParse = _requireOpt('pdf-parse');

/**
 * Convert a PDF → markdown-ish text.
 *
 * @param {string} filePath  absolute path to .pdf
 * @param {object} opts
 * @returns {Promise<{ok: true, mdText: string, level: 'native', stats: object} | {ok: false, reason: string}>}
 */
async function convertPdfNative(filePath, opts = {}) {
  if (!pdfParse) return { ok: false, reason: 'pdf-parse not installed' };
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'file not found' };

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  if (onProgress) onProgress({ stage: 'native-pdf-start', message: 'PDF → text (native)' });

  const t0 = Date.now();
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, reason: 'read failed: ' + ((err && err.message) || err) };
  }

  let result;
  try {
    result = await pdfParse(buf, { max: 0 }); // 0 = all pages
  } catch (err) {
    return { ok: false, reason: 'pdf-parse threw: ' + ((err && err.message) || err) };
  }

  const text = (result && result.text) ? String(result.text) : '';
  const pageCount = result && result.numpages ? result.numpages : 0;

  // 2026-05-18 — OCR auto-fallback when pdf-parse returns empty text on a
  // PDF with pages (scan-only / image-only PDF). Uses bundled tesseract.js +
  // @napi-rs/canvas + pdfjs-dist via app/lib/ocr.js. First call downloads
  // chi_sim+eng traineddata (~25MB) — net required ONCE, cached locally.
  // Performance: ~5-15s/page on i7. 400-page book → 35-100 min.
  // User can disable via opts.allowOcr=false (caller-side opt-out).
  if (!text.trim() && pageCount > 0 && opts.allowOcr !== false) {
    try {
      if (onProgress) onProgress({
        stage: 'native-pdf-ocr-start',
        message: `PDF 无文字层 (${pageCount} 页), 启 OCR — 估时 ${Math.round(pageCount * 0.15)}-${Math.round(pageCount * 0.5)} min`,
      });
      const { ocrPdf } = require('../ocr');
      const ocrRes = await ocrPdf(filePath, {
        langs: opts.ocrLangs || 'chi_sim+eng',
        langPath: opts.ocrLangPath,
        cachePath: opts.ocrCachePath,
        signal: opts.signal,
        onProgress: (p) => {
          if (onProgress) {
            onProgress({
              stage: 'native-pdf-ocr-page',
              message: `OCR · 第 ${p.page || '?'}/${p.total || pageCount} 页`,
              percent: p.page && p.total ? (p.page / p.total) * 100 : null,
            });
          }
        },
      });
      const ocrText = String((ocrRes && ocrRes.text) || '').trim();
      if (ocrText.length > 0) {
        const mdText = ocrText
          .replace(/\r\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        const ms = Date.now() - t0;
        if (onProgress) onProgress({ stage: 'native-pdf-ocr-done', message: `OCR 完成 · ${pageCount} 页 · ${mdText.length} 字 · ${Math.round(ms / 1000)}s` });
        return {
          ok: true,
          mdText,
          level: 'ocr',
          stats: { ms, pages: pageCount, total_chars: mdText.length, ext: 'pdf', method: 'tesseract-ocr' },
        };
      }
      return { ok: false, reason: 'OCR returned empty text — PDF may be corrupted or pure-graphic' };
    } catch (ocrErr) {
      return { ok: false, reason: 'OCR fallback failed: ' + ((ocrErr && ocrErr.message) || ocrErr) };
    }
  }

  if (!text.trim()) {
    return { ok: false, reason: 'empty text — likely image-only PDF, OCR needed' };
  }

  // Light cleanup: collapse 3+ newlines, trim page-headers that repeat per page.
  const mdText = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const ms = Date.now() - t0;
  if (onProgress) onProgress({ stage: 'native-pdf-done', message: `PDF → text 完成 · ${pageCount || '?'} 页 · ${mdText.length} 字 · ${ms}ms` });

  return {
    ok: true,
    mdText,
    level: 'native',
    stats: { ms, pages: pageCount || null, total_chars: mdText.length, ext: 'pdf' },
  };
}

module.exports = { convertPdfNative };
