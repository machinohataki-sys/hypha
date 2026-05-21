'use strict';

// HYPHA · source-conference-extractor — Layer 3 deep-extract for conferences.
//
// Per `project_hypha_5layer_scrape_spec` (memory 2026-05-09):
//   For NeurIPS / ICML / ICLR / ACL / EMNLP / CVPR / ICCV / ECCV / KDD / CHI /
//   USENIX / SOSP / OSDI, do NOT just grab paper titles. Pull:
//     - Tutorial         (half-day / full-day primer sessions)
//     - Workshop         (focused track around a subtopic)
//     - Keynote          (invited speaker = field narrative)
//     - Best Paper       (community-validated quality signal)
//     - Oral / Spotlight (top-tier accepted, ~5-10%)
//     - Accepted Paper   (full list)
//     - OpenReview review thread
//     - Benchmark updates
//
// CONTRACT
//   extractConferenceFields({ url, html, archetype? }) → {
//     ok: boolean,
//     conference_id: string|null,   // 'neurips' / 'icml' / 'openreview' / null
//     conference_year: number|null,
//     fields: {
//       tutorials:    Array<{title, presenters?, url?}>,
//       workshops:    Array<{title, organizers?, url?}>,
//       keynotes:     Array<{title, speaker?, url?}>,
//       best_papers:  Array<{title, authors?, award?, url?}>,
//       orals:        Array<{title, authors?, url?}>,
//       spotlights:   Array<{title, authors?, url?}>,
//       accepted:     Array<{title, authors?, url?}>,
//       openreview_reviews: Array<{paper_title, review_excerpt, score?, url?}>,
//       benchmarks:   Array<{name, sota_claim?, dataset?, url?}>
//     },
//     stats: { total_items: number, sections_found: Array<string> },
//     reason?: string
//   }
//
// IMPLEMENTATION
// - Heuristic-first: URL host pattern → conference id; HTML section detection
//   via cheerio (already in package.json) + headers/keywords; fall back to
//   regex when cheerio not available or HTML is sparse.
// - This batch processes synthetic fixtures. Real-fetch wiring is downstream
//   harvest pipeline's job — same `extractConferenceFields` signature accepts
//   { url, html } so it composes naturally.
//
// Per coding-style.md: pure function (no fetch, no fs), explicit narrow input.

let cheerio = null;
try { cheerio = require('cheerio'); } catch (_) { /* fall back to regex path */ }

const CONFERENCE_HOST_PATTERNS = Object.freeze([
  { id: 'neurips',     re: /(?:^|\.)neurips\.cc$/i },
  { id: 'neurips',     re: /(?:^|\.)nips\.cc$/i },
  { id: 'icml',        re: /(?:^|\.)icml\.cc$/i },
  { id: 'iclr',        re: /(?:^|\.)iclr\.cc$/i },
  { id: 'acl',         re: /(?:^|\.)aclweb\.org$/i },
  { id: 'acl',         re: /(?:^|\.)aclanthology\.org$/i },
  { id: 'cvf',         re: /(?:^|\.)thecvf\.com$/i }, // CVPR/ICCV/ECCV
  { id: 'kdd',         re: /(?:^|\.)kdd\.org$/i },
  { id: 'chi',         re: /(?:^|\.)chi\d{4}\.acm\.org$/i },
  { id: 'usenix',      re: /(?:^|\.)usenix\.org$/i },
  { id: 'sosp',        re: /(?:^|\.)sigops\.org$/i },
  { id: 'openreview',  re: /(?:^|\.)openreview\.net$/i },
]);

const SECTION_KEYWORDS = Object.freeze({
  tutorials:   [/\btutorial(s)?\b/i, /\bhalf[- ]day\b/i, /\bfull[- ]day\b/i],
  workshops:   [/\bworkshop(s)?\b/i, /\baffiliated workshop/i],
  keynotes:    [/\bkeynote(s)?\b/i, /\binvited talk/i, /\bplenary\b/i],
  best_papers: [/\bbest paper(s)?\b/i, /\boutstanding paper/i, /\bpaper award/i, /\brunner[- ]up/i],
  orals:       [/\boral(s)?\b/i, /\boral presentation/i],
  spotlights:  [/\bspotlight(s)?\b/i],
  accepted:    [/\baccepted paper(s)?\b/i, /\bmain track\b/i],
  openreview_reviews: [/\bopenreview\b/i, /\breview thread\b/i, /\brebuttal\b/i],
  benchmarks:  [/\bbenchmark(s)?\b/i, /\bsota\b/i, /\bleaderboard\b/i, /\bdataset release/i],
});

function _hostnameOf(url) {
  if (typeof url !== 'string') return '';
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

function _detectConferenceFromHost(url) {
  const host = _hostnameOf(url);
  if (!host) return null;
  for (const entry of CONFERENCE_HOST_PATTERNS) {
    if (entry.re.test(host)) return entry.id;
  }
  return null;
}

function _detectYear(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\b(20\d{2})\b/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  // Sanity: conferences active range 2010-current+1.
  if (y >= 2010 && y <= 2030) return y;
  return null;
}

function _matchSection(headingText, field) {
  const kws = SECTION_KEYWORDS[field];
  if (!kws) return false;
  for (const re of kws) {
    if (re.test(headingText)) return true;
  }
  return false;
}

function _classifySection(headingText) {
  // Order matters: more specific (best_papers / orals) before generic (accepted).
  const order = ['best_papers', 'tutorials', 'workshops', 'keynotes', 'orals', 'spotlights', 'openreview_reviews', 'benchmarks', 'accepted'];
  for (const field of order) {
    if (_matchSection(headingText, field)) return field;
  }
  return null;
}

function _extractItemsViaCheerio(html) {
  const $ = cheerio.load(html);
  const sectionsFound = new Set();
  const result = {
    tutorials: [], workshops: [], keynotes: [], best_papers: [],
    orals: [], spotlights: [], accepted: [], openreview_reviews: [], benchmarks: [],
  };

  // Walk every heading h1-h4 + dt + section header; for each, find the next
  // sibling list of items (ul / ol / table rows) until the next heading.
  const headings = $('h1, h2, h3, h4, header, .section-title, dt');
  headings.each((_, el) => {
    const headingText = $(el).text().trim();
    if (!headingText) return;
    const field = _classifySection(headingText);
    if (!field) return;
    sectionsFound.add(field);
    // Collect immediately-following list items / table rows until next heading.
    let node = el.next;
    let safety = 0;
    while (node && safety < 200) {
      safety++;
      const $node = $(node);
      const tag = (node.tagName || node.name || '').toLowerCase();
      if (['h1', 'h2', 'h3', 'h4'].includes(tag)) break;
      if (tag === 'ul' || tag === 'ol') {
        $node.find('li').each((__, li) => {
          const $li = $(li);
          const text = $li.text().trim();
          if (!text) return;
          const anchor = $li.find('a').first();
          const url = anchor.length ? (anchor.attr('href') || null) : null;
          result[field].push({
            title: text.slice(0, 300),
            url: url || undefined,
          });
        });
      } else if (tag === 'table') {
        $node.find('tr').each((__, tr) => {
          const txt = $(tr).text().trim();
          if (!txt) return;
          if (/^\s*(title|paper|name|presenter|author)\s*$/i.test(txt)) return;
          const anchor = $(tr).find('a').first();
          const url = anchor.length ? (anchor.attr('href') || null) : null;
          result[field].push({
            title: txt.slice(0, 300),
            url: url || undefined,
          });
        });
      } else if (tag === 'p' || tag === 'div') {
        const text = $node.text().trim();
        // Treat one-liner div/p as a single item, otherwise skip noise.
        if (text && text.length < 250 && /\w/.test(text)) {
          result[field].push({ title: text.slice(0, 300) });
        }
      }
      node = node.next;
    }
  });

  return { items: result, sectionsFound: Array.from(sectionsFound) };
}

function _extractItemsViaRegex(html) {
  // Minimal fallback when cheerio isn't available. Looks for
  // <h[1-4]>...</h[1-4]> blocks and grabs subsequent <li> entries up to the
  // next heading. Not as precise as cheerio but covers fixture-shaped HTML.
  const sectionsFound = new Set();
  const result = {
    tutorials: [], workshops: [], keynotes: [], best_papers: [],
    orals: [], spotlights: [], accepted: [], openreview_reviews: [], benchmarks: [],
  };
  const headingRe = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let m;
  const positions = [];
  while ((m = headingRe.exec(html)) !== null) {
    const headingText = String(m[1]).replace(/<[^>]+>/g, '').trim();
    const field = _classifySection(headingText);
    positions.push({ idx: m.index + m[0].length, field, headingText });
  }
  for (let i = 0; i < positions.length; i++) {
    const cur = positions[i];
    if (!cur.field) continue;
    sectionsFound.add(cur.field);
    const end = i + 1 < positions.length ? positions[i + 1].idx - (positions[i + 1].headingText.length + 10) : html.length;
    const chunk = html.slice(cur.idx, end);
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let li;
    while ((li = liRe.exec(chunk)) !== null) {
      const liHtml = String(li[1]);
      const text = liHtml.replace(/<[^>]+>/g, '').trim();
      if (!text) continue;
      const hrefMatch = liHtml.match(/href=["']([^"']+)["']/i);
      result[cur.field].push({
        title: text.slice(0, 300),
        url: hrefMatch ? hrefMatch[1] : undefined,
      });
    }
  }
  return { items: result, sectionsFound: Array.from(sectionsFound) };
}

function _countItems(items) {
  let n = 0;
  for (const k of Object.keys(items)) n += items[k].length;
  return n;
}

/**
 * extractConferenceFields — parse a conference page into structured fields.
 *
 * @param {object} params
 * @param {string} [params.url]    optional URL (used for conference id detect)
 * @param {string} params.html     HTML string to parse (required)
 * @param {string} [params.archetype]  optional archetype hint (unused currently)
 * @returns {object} structured fields per CONTRACT above
 */
function extractConferenceFields(params) {
  const p = params || {};
  if (typeof p.html !== 'string' || p.html.length === 0) {
    return {
      ok: false,
      conference_id: null,
      conference_year: null,
      fields: _emptyFields(),
      stats: { total_items: 0, sections_found: [] },
      reason: 'no html provided',
    };
  }
  const conference_id = _detectConferenceFromHost(p.url);
  const conference_year = _detectYear(p.html) || (p.url ? _detectYear(p.url) : null);
  const parsed = cheerio ? _extractItemsViaCheerio(p.html) : _extractItemsViaRegex(p.html);
  return {
    ok: true,
    conference_id,
    conference_year,
    fields: parsed.items,
    stats: {
      total_items: _countItems(parsed.items),
      sections_found: parsed.sectionsFound,
    },
  };
}

function _emptyFields() {
  return {
    tutorials: [], workshops: [], keynotes: [], best_papers: [],
    orals: [], spotlights: [], accepted: [], openreview_reviews: [], benchmarks: [],
  };
}

module.exports = Object.freeze({
  extractConferenceFields,
  CONFERENCE_HOST_PATTERNS,
  SECTION_KEYWORDS,
  _detectConferenceFromHost,
  _classifySection,
});
