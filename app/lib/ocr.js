'use strict';

// HYPHA · OCR module — automatic scanned-PDF text extraction.
//
// Triggered by source-extractor._extractPdf when pdf-parse returns empty text
// (indicating no text layer / scanned image PDF). Pipeline:
//   1. pdfjs-dist (v4 legacy ESM build) decodes PDF + provides page render
//   2. @napi-rs/canvas rasterizes each page to PNG buffer (scale=2 for OCR
//      legibility — ~1.5MB per A4 page, ~600MB for 400-page Copleston)
//   3. tesseract.js OCRs each page with chi_sim+eng languages
//
// Performance: ~5-15s per page on i7 (Tesseract LSTM). 400-page Copleston
// ≈ 35-100 min. User sees per-page progress events streamed via onProgress.
//
// First run downloads chi_sim.traineddata (~20MB) + eng.traineddata (~4MB)
// from tessdata CDN — net required ONCE, cached locally after. Cache lives
// under {userData}/tessdata when called from main process; fallback to cwd
// tessdata when langPath not supplied (lib-only test contexts).

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

const DEFAULT_LANGS = 'chi_sim+eng';
const PAGE_RENDER_SCALE = 1.5;   // was 2; trims raster 44% with marginal accuracy hit
const DEFAULT_TESSDATA_CDN = 'https://tessdata.projectnaptha.com/4.0.0_fast';
// _fast vs _best — chi_sim_fast is ~3MB (vs 52MB _best), ~2.5x faster decoding.
// Accuracy drop 2-4% on clean scans, often invisible at the harvest layer (we
// retrieve by keyword match, not character-perfect quote). User can opt into
// _best via HYPHA_OCR_QUALITY=best env var.
const OCR_QUALITY_OVERRIDE = (process.env.HYPHA_OCR_QUALITY || '').toLowerCase();
const _resolvedCdn = OCR_QUALITY_OVERRIDE === 'best'
  ? 'https://tessdata.projectnaptha.com/4.0.0_best'
  : DEFAULT_TESSDATA_CDN;

// Worker pool size — physical CPU cores are the real bottleneck (Tesseract
// LSTM decode is CPU-bound, single-core per worker). Diminishing returns past
// ~6 workers due to message-passing overhead between scheduler + WASM workers.
//
// Defaults: floor(cpus/2) capped at 4 — leaves room for UI thread + pdfjs
// rasterizer running in parallel. User can override via HYPHA_OCR_WORKERS=N
// (e.g. =6 on 16-core workstation, =1 on low-end laptop).
//
// Why not "spawn 400 workers for 400 pages": each worker holds LSTM model in
// memory (~80-150MB) + lang data + raster buffers. 400 workers = 30-60GB RAM
// = OOM. Plus 400 workers contend for same 4-16 physical cores → round-robin
// scheduling has zero net speedup, often slower than 4 workers due to context
// switching overhead.
const NUM_WORKERS = (() => {
  const env = parseInt(process.env.HYPHA_OCR_WORKERS, 10);
  if (Number.isFinite(env) && env > 0) return Math.min(8, env);
  try {
    const cpus = require('node:os').cpus().length;
    return Math.max(1, Math.min(4, Math.floor(cpus / 2)));
  } catch (_) { return 2; }
})();

// Manual traineddata pre-download. Tesseract.js v6 internal fetch hangs at 0%
// in Electron main process (observed 2026-05-13 — chi_sim.traineddata.gz never
// starts). Pre-fetching with node:https + streaming gives us real progress +
// reliable behavior. After files exist locally, Tesseract gets langPath=local
// so its loader reads from disk without re-downloading.
function _downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      // Follow redirects (GitHub Pages → assets.githubusercontent.com)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        _downloadFile(res.headers.location, destPath, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} on ${url}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      const tmpPath = destPath + '.part';
      const out = fs.createWriteStream(tmpPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress({ received, total });
      });
      res.on('error', (err) => { out.destroy(); reject(err); });
      out.on('error', (err) => { reject(err); });
      out.on('finish', () => {
        out.close((err) => {
          if (err) return reject(err);
          fs.rename(tmpPath, destPath, (rErr) => rErr ? reject(rErr) : resolve());
        });
      });
      res.pipe(out);
    });
    req.on('timeout', () => { req.destroy(new Error('download timeout (30s)')); });
    req.on('error', reject);
  });
}

async function _ensureLangFiles(langArray, cachePath, cdnBase, onProgress) {
  await fsp.mkdir(cachePath, { recursive: true });
  for (const lang of langArray) {
    const fileName = `${lang}.traineddata.gz`;
    const dest = path.join(cachePath, fileName);
    if (fs.existsSync(dest)) {
      if (onProgress) onProgress({ stage: 'lang-cached', lang, cached: true });
      continue;
    }
    const url = `${cdnBase}/${fileName}`;
    if (onProgress) onProgress({ stage: 'lang-download-start', lang, url });
    try {
      await _downloadFile(url, dest, ({ received, total }) => {
        if (onProgress) {
          const pct = total > 0 ? received / total : 0;
          onProgress({ stage: 'lang-downloading', lang, received, total, pageProgress: pct });
        }
      });
      if (onProgress) onProgress({ stage: 'lang-download-done', lang });
    } catch (err) {
      // Clean up partial file so retry works
      try { fs.unlinkSync(dest); } catch (_) {}
      try { fs.unlinkSync(dest + '.part'); } catch (_) {}
      throw new Error(`failed to download ${lang}.traineddata.gz: ${err.message}`);
    }
  }
}

let _pdfjsPromise = null;
let _canvasMod = null;
let _tesseract = null;

async function _loadPdfjs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfjsPromise;
}

function _loadSyncDeps() {
  if (!_canvasMod) _canvasMod = require('@napi-rs/canvas');
  if (!_tesseract) _tesseract = require('tesseract.js');
}

async function _renderPdfPageToPng(pdfDoc, pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: PAGE_RENDER_SCALE });
  const canvas = _canvasMod.createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  // pdfjs v4 accepts a node-canvas-compatible context. @napi-rs/canvas exposes
  // the same 2D API surface. White background under the page so OCR doesn't
  // pick up transparent-pixel artefacts.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  const buf = canvas.toBuffer('image/png');
  page.cleanup();
  return buf;
}

/**
 * OCR a scanned PDF — rasterize each page + run Tesseract on it.
 *
 * @param {string} filePath           absolute path to PDF
 * @param {object} opts
 * @param {string} opts.langs         e.g. 'chi_sim+eng'. Default DEFAULT_LANGS.
 * @param {string} opts.langPath      where to cache traineddata (electron userData)
 * @param {AbortSignal} opts.signal   throw on abort between pages
 * @param {Function}    opts.onProgress({stage, page, total, pageProgress?})
 * @returns {{text, pageCount}}
 */
async function ocrPdf(filePath, opts = {}) {
  if (!filePath) throw new Error('no filePath');
  if (!fs.existsSync(filePath)) throw new Error('file not found: ' + filePath);
  _loadSyncDeps();
  const pdfjs = await _loadPdfjs();

  const langs = (opts.langs || DEFAULT_LANGS).trim();
  const langArray = langs.split('+').map(s => s.trim()).filter(Boolean);
  const onProgress = opts.onProgress || (() => {});
  const signal = opts.signal || null;

  // Load PDF
  if (signal && signal.aborted) throw new Error('aborted');
  onProgress({ stage: 'load', page: 0, total: 0 });
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const total = pdf.numPages;
  onProgress({ stage: 'loaded', page: 0, total });

  if (signal && signal.aborted) {
    await pdf.cleanup();
    throw new Error('aborted');
  }

  // Resolve cache location for traineddata files. Caller may pass either
  // (langPath = URL + cachePath = local dir) OR just cachePath. If neither
  // is set, default to ./tessdata in cwd.
  const cachePath = opts.cachePath || path.join(process.cwd(), 'tessdata');
  const cdnBase = (opts.langPath && /^https?:\/\//.test(opts.langPath))
    ? opts.langPath
    : DEFAULT_TESSDATA_CDN;

  // Pre-download lang files (manual https) — avoids Tesseract.js v6 internal
  // fetch hanging at 0% in Electron Node.
  onProgress({ stage: 'tesseract-init', page: 0, total, langs });
  try {
    await _ensureLangFiles(langArray, cachePath, cdnBase, onProgress);
  } catch (dlErr) {
    await pdf.cleanup();
    throw new Error('lang download failed: ' + dlErr.message);
  }

  // Spin up worker pool via Scheduler — multiple workers consume the job queue
  // in parallel, giving ~Nx OCR speedup. Each worker loads the same lang data
  // from local cache, no extra network calls.
  const scheduler = _tesseract.createScheduler();
  const workers = [];
  for (let w = 0; w < NUM_WORKERS; w++) {
    const worker = await _tesseract.createWorker(langArray, undefined, {
      langPath: cachePath,
      cachePath,
      cacheMethod: 'none',
      gzip: true,
      logger: (m) => {
        if (m && m.status === 'recognizing text' && typeof m.progress === 'number') {
          onProgress({ stage: 'recognizing', page: null, total, pageProgress: m.progress });
        }
      },
    });
    scheduler.addWorker(worker);
    workers.push(worker);
  }

  // Pipelined raster + OCR across N parallel lanes. Each lane pulls the next
  // page index, rasterizes, hands to scheduler (which routes to a free worker).
  // Memory bounded — at most NUM_WORKERS PNG buffers in flight + 1-2 queued.
  const pages = new Array(total);
  let nextPage = 1;
  let donePages = 0;

  const runLane = async () => {
    while (true) {
      if (signal && signal.aborted) throw new Error('aborted');
      const i = nextPage++;
      if (i > total) break;
      onProgress({ stage: 'rasterize', page: i, total });
      const imgBuf = await _renderPdfPageToPng(pdf, i);
      if (signal && signal.aborted) throw new Error('aborted');
      onProgress({ stage: 'ocr', page: i, total });
      const result = await scheduler.addJob('recognize', imgBuf);
      pages[i - 1] = (result && result.data && result.data.text) || '';
      donePages += 1;
      onProgress({ stage: 'page-done', page: donePages, total });
    }
  };

  try {
    const lanes = [];
    for (let k = 0; k < NUM_WORKERS; k++) lanes.push(runLane());
    await Promise.all(lanes);
  } finally {
    try { await scheduler.terminate(); } catch (_) {}
    try { await pdf.cleanup(); } catch (_) {}
  }

  const combined = pages.filter(Boolean).join('\n\n').trim();
  return { text: combined, pageCount: total };
}

module.exports = { ocrPdf, DEFAULT_LANGS };
