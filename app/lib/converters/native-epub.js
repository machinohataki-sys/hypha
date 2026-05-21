'use strict';
// HYPHA · native-epub — fast EPUB→MD via JSZip + cheerio + turndown.
//
// 5-10x faster than markitdown subprocess for EPUB (no Python startup, no IPC).
// EPUB internals = ZIP container holding XHTML chapters. We unzip, find spine
// (reading order) from container.xml + content.opf, walk spine, strip with
// cheerio, convert via turndown.
//
// Dynamic-require jszip with try/catch — falls back gracefully if dep missing
// (caller treats null return as "skip L1, try L2 markitdown").
//
// Fidelity: chapter text + headings + paragraphs + lists + links. Loses CSS,
// images (alt text kept). Footnotes preserved as inline. Tables: turndown
// renders them as MD tables. Good enough for grounding learning material.

const fs = require('fs');
const path = require('path');

function _requireOpt(name) {
  try { return require(name); } catch (_) { return null; }
}

const JSZip = _requireOpt('jszip');
const cheerio = _requireOpt('cheerio');
const TurndownService = _requireOpt('turndown');

/**
 * Convert an EPUB file → markdown text.
 *
 * @param {string} filePath  absolute path to .epub
 * @param {object} opts
 * @param {function} opts.onProgress  optional progress callback
 * @returns {Promise<{ok: true, mdText: string, level: 'native', stats: object} | {ok: false, reason: string}>}
 */
async function convertEpubNative(filePath, opts = {}) {
  if (!JSZip) return { ok: false, reason: 'jszip not installed' };
  if (!cheerio) return { ok: false, reason: 'cheerio not installed' };
  if (!TurndownService) return { ok: false, reason: 'turndown not installed' };
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'file not found' };

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  if (onProgress) onProgress({ stage: 'native-epub-start', message: 'EPUB → MD (native)' });

  const t0 = Date.now();
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, reason: 'read failed: ' + ((err && err.message) || err) };
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (err) {
    return { ok: false, reason: 'unzip failed: ' + ((err && err.message) || err) };
  }

  // Find content.opf path via META-INF/container.xml
  let opfPath = null;
  try {
    const containerXml = await zip.file('META-INF/container.xml').async('string');
    const $ = cheerio.load(containerXml, { xmlMode: true });
    opfPath = $('rootfile').first().attr('full-path') || null;
  } catch (err) {
    return { ok: false, reason: 'container.xml missing/malformed: ' + ((err && err.message) || err) };
  }
  if (!opfPath) return { ok: false, reason: 'no rootfile in container.xml' };

  // Read opf → spine (ordered list of itemref idref → manifest item → href)
  let opfXml;
  try {
    const opfFile = zip.file(opfPath);
    if (!opfFile) return { ok: false, reason: 'opf file not in zip: ' + opfPath };
    opfXml = await opfFile.async('string');
  } catch (err) {
    return { ok: false, reason: 'opf read failed: ' + ((err && err.message) || err) };
  }

  const $opf = cheerio.load(opfXml, { xmlMode: true });
  const opfDir = path.posix.dirname(opfPath.replace(/\\/g, '/'));

  // Build idref → href map from manifest
  const manifestMap = {};
  $opf('manifest item').each((_, el) => {
    const id = $opf(el).attr('id');
    const href = $opf(el).attr('href');
    if (id && href) manifestMap[id] = href;
  });

  // Walk spine itemref in order
  const spineHrefs = [];
  $opf('spine itemref').each((_, el) => {
    const idref = $opf(el).attr('idref');
    if (idref && manifestMap[idref]) {
      const fullHref = opfDir ? path.posix.join(opfDir, manifestMap[idref]) : manifestMap[idref];
      spineHrefs.push(fullHref);
    }
  });

  if (spineHrefs.length === 0) return { ok: false, reason: 'spine empty' };

  // Init turndown
  const td = new TurndownService({
    headingStyle: 'atx',          // # H1 not underlined
    codeBlockStyle: 'fenced',     // ```...```
    bulletListMarker: '-',
    emDelimiter: '_',
    strongDelimiter: '**',
  });
  // Strip <script>, <style>, <link>, <meta> entirely
  td.remove(['script', 'style', 'link', 'meta', 'head']);

  const chapters = [];
  let totalChars = 0;

  for (let i = 0; i < spineHrefs.length; i++) {
    const href = spineHrefs[i];
    let xhtml;
    try {
      const zf = zip.file(href);
      if (!zf) continue;
      xhtml = await zf.async('string');
    } catch (_) {
      continue;
    }
    let chapterMd = '';
    try {
      // Use cheerio with body only — most EPUBs nest content in <body>.
      const $ch = cheerio.load(xhtml);
      const bodyHtml = $ch('body').html() || $ch.root().html() || xhtml;
      chapterMd = td.turndown(bodyHtml);
    } catch (_) {
      continue;
    }
    chapterMd = chapterMd.replace(/\n{3,}/g, '\n\n').trim();
    if (chapterMd) {
      chapters.push(chapterMd);
      totalChars += chapterMd.length;
    }
    if (onProgress && i % 10 === 0) {
      onProgress({ stage: 'native-epub-chapter', message: `章节 ${i + 1}/${spineHrefs.length}`, percent: ((i + 1) / spineHrefs.length) * 100 });
    }
  }

  if (chapters.length === 0) return { ok: false, reason: 'no readable chapters' };

  const mdText = chapters.join('\n\n---\n\n');
  const ms = Date.now() - t0;
  if (onProgress) onProgress({ stage: 'native-epub-done', message: `EPUB → MD 完成 · ${chapters.length} 章 · ${mdText.length} 字 · ${ms}ms` });

  return {
    ok: true,
    mdText,
    level: 'native',
    stats: { ms, chapters: chapters.length, total_chars: totalChars, ext: 'epub' },
  };
}

module.exports = { convertEpubNative };
