'use strict';
// HYPHA · file-converter — 4-level fallback orchestrator (2026-05-18, scored 2026-05-19).
//
// User 2026-05-18 lock: "有没有加速的方法, 绝对不报错, 万一报错有第二条路".
// User 2026-05-19 extend: "PDF/DOC/EPUB/TXT 一切 → LLM-friendly MD lossless".
//
// Architecture:
//   加速:        L1 native (JS in-process, no Python startup)
//   绝不报错:    每 level try/catch; L4 raw-stash always succeeds (file copy)
//   第二条路:    L1 fail → L2 markitdown → L3 raw-extract → L4 raw-stash
//   保真度:      fidelity-scorer 评 0-1, 若 <0.5 自动 rerun 下一级 (auto-rerun)
//   honest:      返回所有 attempts + 最佳级的 fidelity breakdown
//
// Contract:
//   convertFile(filePath, opts) ALWAYS resolves with { ok: true, mdText, level, fidelity, ... }
//   Only throws if even L4 raw-stash filesystem operation crashes
//   (disk full / permission denied — at that point UI shows "硬盘问题").
//
// Levels:
//   L1 native     — native-epub / native-pdf / native-docx / native-html (fast, ! Python)
//   L2 markitdown — Microsoft markitdown via Python subprocess (rich, slow)
//   L3 raw-extract— JSZip + cheerio text strip (zip-based fmts only)
//   L4 raw-stash  — file copy + stub markdown (always succeeds)
//
// Each result carries `level` enum + `fidelity` score for UI to show honestly.
//
// Pre-warm: markitdown-bridge.checkAvailability cache is session-long; main.js
// whenReady fires fire-and-forget on app boot to absorb 10-30s cold start.

const path = require('path');

const { convertEpubNative } = require('./converters/native-epub');
const { convertPdfV2 } = require('./converters/native-pdf-v2');     // v2 primary (pdfjs-dist direct)
const { convertPdfNative } = require('./converters/native-pdf');    // kept as v2 internal fallback
const { convertDocxNative } = require('./converters/native-docx');
const { convertHtmlNative } = require('./converters/native-html');
const { rawExtract } = require('./converters/raw-extract');
const { rawStash } = require('./converters/raw-stash');
const markitdown = require('./markitdown-bridge');
const { scoreFidelity, tier } = require('./converters/fidelity-scorer');

// Format → native handler map. Extend here as more native parsers ship.
// Missing entry = L1 skipped, jump L2.
const NATIVE_HANDLERS = {
  epub: convertEpubNative,
  pdf:  convertPdfV2,          // v2 primary; falls through internally to v1 (pdf-parse) on failure
  docx: convertDocxNative,
  html: convertHtmlNative,
  htm:  convertHtmlNative,
};

const DEFAULT_MIN_FIDELITY = 0.5;

/**
 * Convert a file → markdown, with always-success contract and fidelity scoring.
 *
 * @param {string} filePath  absolute path
 * @param {object} opts
 * @param {function} opts.onProgress  optional progress callback
 * @param {number}   opts.minFidelity  threshold for auto-accept (default 0.5).
 *                                     If score < this, try next level; return best.
 * @param {boolean}  opts.autoRerun    default true. If false, accept first ok level.
 * @param {number}   opts.expectedPages  optional, fed to scorer for chars/page check
 * @returns {Promise<{ok: true, mdText: string, level: string, fidelity: object, stats: object, attempts: Array}>}
 */
async function convertFile(filePath, opts = {}) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const minFidelity = typeof opts.minFidelity === 'number' ? opts.minFidelity : DEFAULT_MIN_FIDELITY;
  const autoRerun = opts.autoRerun !== false;
  const expectedPages = typeof opts.expectedPages === 'number' ? opts.expectedPages : undefined;
  const attempts = [];
  let best = null; // { result, fidelity_score }

  const tryAndScore = async (label, fn) => {
    if (onProgress) onProgress({ stage: 'level-try', message: label });
    const t0 = Date.now();
    try {
      const r = await fn();
      const elapsed = Date.now() - t0;
      if (r && r.ok) {
        const fidelity = scoreFidelity({
          mdText: r.mdText,
          ext,
          expected_pages: expectedPages,
          parsed_level: r.level || label,
        });
        const enriched = {
          ...r,
          fidelity,
          fidelity_score: fidelity.score,
          fidelity_tier: fidelity.tier,
        };
        attempts.push({
          level: label,
          ok: true,
          ms: elapsed,
          fidelity_score: fidelity.score,
          fidelity_tier: fidelity.tier,
        });
        return enriched;
      }
      attempts.push({
        level: label,
        ok: false,
        ms: elapsed,
        reason: (r && r.reason) || 'returned !ok',
      });
      return null;
    } catch (err) {
      attempts.push({
        level: label,
        ok: false,
        ms: Date.now() - t0,
        reason: (err && err.message) || String(err),
        threw: true,
      });
      return null;
    }
  };

  const considerResult = (r) => {
    if (!r) return false;
    if (!best || r.fidelity.score > best.fidelity.score) best = r;
    if (!autoRerun) return true; // first ok wins
    return r.fidelity.score >= minFidelity;
  };

  // ─── L1 native ─────────────────────────────────────────────────────────
  const nativeHandler = NATIVE_HANDLERS[ext];
  if (nativeHandler) {
    const r = await tryAndScore('native', () => nativeHandler(filePath, { onProgress }));
    if (considerResult(r)) return { ...best, attempts };
  } else {
    attempts.push({ level: 'native', skipped: true, reason: `no native handler for .${ext}` });
  }

  // ─── L2 markitdown ─────────────────────────────────────────────────────
  if (markitdown.isConvertible(ext)) {
    const r = await tryAndScore('markitdown', async () => {
      try {
        const conv = await markitdown.convertToMarkdown(filePath, { onProgress });
        if (conv && conv.mdText && conv.mdText.trim()) {
          return {
            ok: true,
            mdText: conv.mdText,
            level: 'markitdown',
            stats: { ext, total_chars: conv.mdText.length, method: 'markitdown-subprocess' },
          };
        }
        return { ok: false, reason: 'markitdown returned empty' };
      } catch (err) {
        return { ok: false, reason: (err && err.message) || String(err) };
      }
    });
    if (considerResult(r)) return { ...best, attempts };
  } else {
    attempts.push({ level: 'markitdown', skipped: true, reason: `ext .${ext} not in CONVERTIBLE_EXTS` });
  }

  // ─── L3 raw-extract ────────────────────────────────────────────────────
  const r3 = await tryAndScore('raw-extract', () => rawExtract(filePath, { onProgress }));
  if (considerResult(r3)) return { ...best, attempts };

  // ─── L4 raw-stash (must succeed) ───────────────────────────────────────
  const r4 = await tryAndScore('raw-stash', () => rawStash(filePath, { onProgress }));
  if (r4) {
    if (!best || r4.fidelity.score > best.fidelity.score) best = r4;
  }

  // Return best of all attempts (worst case raw-stash)
  if (best) return { ...best, attempts };

  // If even L4 failed (filesystem broken), throw — caller decides UI message.
  throw new Error('all 4 levels failed including raw-stash: ' + JSON.stringify(attempts));
}

module.exports = {
  convertFile,
  NATIVE_HANDLERS,
  DEFAULT_MIN_FIDELITY,
};
