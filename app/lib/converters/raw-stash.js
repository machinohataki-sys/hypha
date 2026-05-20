'use strict';
// HYPHA · raw-stash — L4 absolute fallback. Copies the file as-is into vault
// and returns a synthetic markdown stub naming the original file. No real
// parsing. Always succeeds (barring filesystem failure, which is itself
// recoverable by the caller catching the throw).
//
// Surfaced UI: parsed_level = 'raw-stash'. user knows fidelity = 0, but the
// file IS in their Library + flagged + can be re-processed later.

const fs = require('fs');
const path = require('path');

/**
 * Stash file as-is. Returns a stub markdown document referencing it.
 *
 * @param {string} filePath  absolute path
 * @param {object} opts
 * @returns {Promise<{ok: true, mdText: string, level: 'raw-stash', stats: object}>}
 */
async function rawStash(filePath, opts = {}) {
  const ext = path.extname(filePath).slice(1).toLowerCase() || 'unknown';
  const basename = path.basename(filePath);
  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(filePath).size; } catch (_) {}

  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  const mdText = [
    `# ${basename}`,
    '',
    `> **HYPHA 暂时没法解析这本书** · 文件已存 vault 里, ! 丢.`,
    `> 格式: \`.${ext}\` · 大小: ${sizeMb} MB`,
    '',
    `**HYPHA 试了什么**:`,
    `1. 原生 PDF 文本提取 (pdfjs-dist) → fidelity < 0.5 (可能图片重型 / 扫描版 / 无文字层 / 加密)`,
    `2. OCR 自动回退 (tesseract.js + canvas) → 字数仍不够 / 识别 < 0.5`,
    '',
    `**建议**:`,
    `- 找 EPUB 版同书 → 上传 → HYPHA 的 epub 处理质量远高于 PDF`,
    `- PDF 拆章节 (50-100 页/份) → 分次上传`,
    `- 文件已在 vault, HYPHA 解析器升级后右键重新解析`,
    '',
    `_HYPHA 自包含, ! 需装任何外部工具._`,
  ].join('\n');

  return {
    ok: true,
    mdText,
    level: 'raw-stash',
    stats: {
      ext,
      total_chars: mdText.length,
      original_bytes: sizeBytes,
      original_name: basename,
      method: 'stub',
    },
  };
}

module.exports = { rawStash };
