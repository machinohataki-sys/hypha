'use strict';
// HYPHA · native-html — HTML → MD via @mozilla/readability (article extraction)
// + turndown projection. Falls back to cheerio strip if readability returns null
// (non-article HTML like docs / wikipedia / app shells).
//
// Fidelity: heading hierarchy preserved, lists & nesting kept, code blocks
// (turndown's default fenced output), images with alt. Strips: nav / footer /
// sidebar / scripts / styles / iframes.
//
// Why readability first: Firefox Reader View algorithm = state-of-art for
// "is this an article?" detection + main-content extraction. Cuts ~90% of
// boilerplate (ads / nav / related-posts) on news/blog/essay sites.

const fs = require('fs');

function _requireOpt(name) {
  try { return require(name); } catch (_) { return null; }
}

const readabilityMod = _requireOpt('@mozilla/readability');
const jsdomMod = _requireOpt('jsdom');
const TurndownService = _requireOpt('turndown');
const cheerio = _requireOpt('cheerio');

const Readability = readabilityMod && readabilityMod.Readability;
const JSDOM = jsdomMod && jsdomMod.JSDOM;

async function convertHtmlNative(filePath, opts = {}) {
  if (!TurndownService) return { ok: false, reason: 'turndown not installed' };
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'file not found' };

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  if (onProgress) onProgress({ stage: 'native-html-start', message: 'HTML → MD (native)' });

  const t0 = Date.now();
  let html;
  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'read failed: ' + ((err && err.message) || err) };
  }
  if (!html.trim()) return { ok: false, reason: 'empty file' };

  // Try readability first (article extraction)
  let cleanHtml = null;
  let title = null;
  let extractMethod = 'unknown';

  if (Readability && JSDOM) {
    try {
      const dom = new JSDOM(html, { url: 'http://localhost/' });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      if (article && article.content && article.content.length > 200) {
        cleanHtml = article.content;
        title = article.title || null;
        extractMethod = 'readability';
      }
    } catch (_) {
      cleanHtml = null;
    }
  }

  // Fallback to cheerio strip
  if (!cleanHtml && cheerio) {
    try {
      const $ = cheerio.load(html);
      $('script, style, link, meta, head, nav, footer, aside, iframe, header, .ad, .ads, .advertisement').remove();
      const body = $('body').html() || $.root().html() || html;
      cleanHtml = body;
      title = $('title').first().text() || null;
      extractMethod = 'cheerio-fallback';
    } catch (_) {
      cleanHtml = html;
      extractMethod = 'raw-html';
    }
  }
  if (!cleanHtml) cleanHtml = html;

  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
    strongDelimiter: '**',
  });
  td.remove(['script', 'style', 'link', 'meta', 'head', 'nav', 'footer', 'aside', 'iframe', 'header']);
  // Strip raw HTML tables to text (avoid spec violation)
  td.addRule('table', {
    filter: 'table',
    replacement: function (content) {
      return '\n\n' + content.replace(/\n\s*\n/g, '\n').trim() + '\n\n';
    },
  });

  let mdText;
  try {
    mdText = td.turndown(cleanHtml);
  } catch (err) {
    return { ok: false, reason: 'turndown threw: ' + ((err && err.message) || err) };
  }

  // Prepend title as H1 if extracted and not already first heading
  if (title && !/^\s*#\s/.test(mdText.trim())) {
    mdText = `# ${title}\n\n${mdText}`;
  }

  mdText = mdText.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!mdText) return { ok: false, reason: 'empty after conversion' };

  const ms = Date.now() - t0;
  if (onProgress) {
    onProgress({
      stage: 'native-html-done',
      message: `HTML → MD 完成 · ${mdText.length} 字 · ${ms}ms · ${extractMethod}`,
    });
  }

  return {
    ok: true,
    mdText,
    level: 'native',
    stats: {
      ms,
      total_chars: mdText.length,
      ext: 'html',
      method: extractMethod,
      title: title || null,
    },
  };
}

module.exports = { convertHtmlNative };
