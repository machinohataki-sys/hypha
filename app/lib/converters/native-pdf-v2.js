'use strict';
// HYPHA · native-pdf-v2 — pdfjs-dist 直用, layout-aware text extraction.
//
// 优势 vs v1 (pdf-parse 包装):
//   - heading 启发式 (字号 distribution → top 5% = H1, top 15% = H2)
//   - multi-column reading-order (y-down + x-right sort)
//   - 图重型页检测 (paintImageXObject op 占比 > 0.5 + items < 10) → 跳文本
//   - 图重型整书 (> 70% 页) → 走 OCR 整本
//   - 输出太空 (< 200 chars) → inline 降 v1 (pdf-parse)
//
// Fail (pdfjs-dist 加载失败 / PDF 损坏 / 加密) → 自动 inline 降 v1. 对外透明.
//
// 输出 contract: { ok, mdText, level: 'native-v2' | 'ocr' | <v1.level>, stats: { ms, pages, total_chars, ext, method, image_heavy_pages, h1_threshold, h2_threshold } }.

const fs = require('fs');

function _requireOpt(name) {
  try { return require(name); } catch (_) { return null; }
}

async function _loadPdfjs() {
  // pdfjs-dist v4.x ESM-only — Electron Node context 用 dynamic import.
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (_) {
    return null;
  }
}

/**
 * Convert a PDF → markdown using pdfjs-dist directly (layout-aware).
 *
 * @param {string} filePath  absolute path to .pdf
 * @param {object} opts
 * @param {function} opts.onProgress  optional progress callback
 * @param {boolean}  opts.allowOcr    default true. If false, skip image-heavy OCR fallback.
 * @param {string}   opts.ocrLangs    default 'chi_sim+eng'
 * @returns {Promise<{ok: true, mdText: string, level: string, stats: object} | {ok: false, reason: string}>}
 */
async function convertPdfV2(filePath, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  if (onProgress) onProgress({ stage: 'native-pdf-v2-start', message: 'PDF → MD (pdfjs-dist 直用)' });

  if (!fs.existsSync(filePath)) return { ok: false, reason: 'file not found' };

  const pdfjs = await _loadPdfjs();
  if (!pdfjs) {
    // pdfjs-dist 加载失败 → inline 降 v1, 用户透明.
    const { convertPdfNative } = require('./native-pdf');
    return await convertPdfNative(filePath, opts);
  }

  const t0 = Date.now();
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, reason: 'read failed: ' + ((err && err.message) || err) };
  }

  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  } catch (err) {
    // PDF 损坏 / 加密 / 密码保护 → 降 v1.
    const { convertPdfNative } = require('./native-pdf');
    return await convertPdfNative(filePath, opts);
  }

  const pageCount = pdf.numPages;
  const pageMarkdowns = [];
  let imageHeavyPages = 0;
  const allFontSizes = [];

  // Pass 1: collect font-size distribution (first 20 pages) for heading threshold.
  const sampleCount = Math.min(pageCount, 20);
  for (let i = 1; i <= sampleCount; i++) {
    try {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (item.height && Number.isFinite(item.height) && item.height > 0) {
          allFontSizes.push(item.height);
        }
      }
    } catch (_) { /* skip page on error */ }
  }
  allFontSizes.sort((a, b) => b - a);
  const h1Threshold = allFontSizes[Math.floor(allFontSizes.length * 0.05)] || 16;
  const h2Threshold = allFontSizes[Math.floor(allFontSizes.length * 0.15)] || 13;
  const bodySize = allFontSizes[Math.floor(allFontSizes.length * 0.50)] || 11;

  // Pass 2: per-page extraction w/ heading 标注 + image-heavy detection.
  for (let i = 1; i <= pageCount; i++) {
    let page, content, ops;
    try {
      page = await pdf.getPage(i);
      content = await page.getTextContent();
      ops = await page.getOperatorList();
    } catch (_) {
      pageMarkdowns.push(`<!-- 第 ${i} 页 · 读取失败 -->`);
      continue;
    }

    // 图占比 — paintImageXObject op / total op > 0.5 + 文本 items < 10 → 图重型, 跳文本.
    const totalOps = ops.fnArray.length;
    const imageOps = ops.fnArray.filter(fn => fn === pdfjs.OPS.paintImageXObject).length;
    const imageRatio = totalOps > 0 ? imageOps / totalOps : 0;
    if (imageRatio > 0.5 && content.items.length < 10) {
      imageHeavyPages++;
      pageMarkdowns.push(`<!-- 第 ${i} 页 · 图重型, 待 OCR -->`);
      continue;
    }

    // Multi-column reading order: y-desc primary, x-asc secondary (y-diff > 2 = different row).
    const items = content.items
      .filter(it => it.str && it.str.trim())
      .map(it => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        height: it.height,
        width: it.width,
      }))
      .sort((a, b) => Math.abs(b.y - a.y) > 2 ? (b.y - a.y) : (a.x - b.x));

    // 按行组合: |Δy| < 2 算同行 (multi-column 一并拼).
    const lines = [];
    let curLine = [];
    let curY = null;
    for (const it of items) {
      if (curY === null || Math.abs(it.y - curY) < 2) {
        curLine.push(it);
        curY = it.y;
      } else {
        lines.push(curLine);
        curLine = [it];
        curY = it.y;
      }
    }
    if (curLine.length) lines.push(curLine);

    // 每行 → MD; heading 启发式 (字号 + 行长).
    const pageMd = lines.map(line => {
      const text = line.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const maxHeight = Math.max(...line.map(it => it.height || bodySize));
      if (maxHeight >= h1Threshold && text.length < 80) return `# ${text}`;
      if (maxHeight >= h2Threshold && text.length < 100) return `## ${text}`;
      return text;
    }).filter(Boolean).join('\n');

    pageMarkdowns.push(pageMd);

    if (onProgress && i % 20 === 0) {
      onProgress({
        stage: 'native-pdf-v2-page',
        message: `第 ${i}/${pageCount} 页`,
        percent: (i / pageCount) * 100,
      });
    }
  }

  // 图重型 > 70% 整书 → OCR 整本.
  if (pageCount > 0 && imageHeavyPages / pageCount > 0.7 && opts.allowOcr !== false) {
    if (onProgress) {
      onProgress({
        stage: 'native-pdf-v2-ocr',
        message: `图重型 ${imageHeavyPages}/${pageCount} 页, OCR 整本`,
      });
    }
    try {
      const { ocrPdf } = require('../ocr');
      const ocrRes = await ocrPdf(filePath, {
        ...opts,
        langs: opts.ocrLangs || 'chi_sim+eng',
      });
      if (ocrRes && ocrRes.text && ocrRes.text.trim()) {
        return {
          ok: true,
          mdText: ocrRes.text.trim(),
          level: 'ocr',
          stats: {
            ms: Date.now() - t0,
            pages: pageCount,
            total_chars: ocrRes.text.length,
            ext: 'pdf',
            method: 'pdfjs-detect+ocr',
            image_heavy_pages: imageHeavyPages,
            h1_threshold: h1Threshold,
            h2_threshold: h2Threshold,
          },
        };
      }
    } catch (_) {
      // OCR failed — fall through to whatever pdfjs already extracted.
    }
  }

  const mdText = pageMarkdowns.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!mdText || mdText.length < 200) {
    // 输出太空 → inline 降 v1.
    const { convertPdfNative } = require('./native-pdf');
    return await convertPdfNative(filePath, opts);
  }

  const ms = Date.now() - t0;
  if (onProgress) {
    onProgress({
      stage: 'native-pdf-v2-done',
      message: `${pageCount} 页 · ${mdText.length} 字 · ${ms}ms`,
    });
  }

  return {
    ok: true,
    mdText,
    level: 'native-v2',
    stats: {
      ms,
      pages: pageCount,
      total_chars: mdText.length,
      ext: 'pdf',
      method: 'pdfjs-dist-direct',
      image_heavy_pages: imageHeavyPages,
      h1_threshold: h1Threshold,
      h2_threshold: h2Threshold,
    },
  };
}

module.exports = { convertPdfV2 };
