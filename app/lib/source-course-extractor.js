'use strict';

// HYPHA · source-course-extractor — Layer 1 deep-extract for course pages.
//
// Per `project_hypha_5layer_scrape_spec` (memory 2026-05-09):
//   For each course (MIT OCW / Stanford / Berkeley / Yale OYC / CMU etc):
//     - Prerequisite   (explicit dependency chain)
//     - Syllabus       (week-by-week outline)
//     - Lecture titles (sequence of topics)
//     - Assignments    (graded exercises = cognitive-load signal)
//     - Projects       (substantial deliverables)
//     - Reading list   (required + recommended)
//     - Exams          (assessment patterns)
//     - Labs           (hands-on components)
//     - Final project  (capstone)
//
// Also captures `course_id` + `institution` heuristics from URL hostpath when
// available — feeds the harvest pipeline's de-dup + provenance.
//
// CONTRACT
//   extractCourseFields({ url, html }) → {
//     ok: boolean,
//     course_id: string|null,
//     institution: string|null,
//     fields: {
//       prerequisites: Array<{text, url?}>,
//       syllabus:      Array<{week?, title, url?}>,
//       lectures:      Array<{title, url?}>,
//       assignments:   Array<{title, url?}>,
//       projects:      Array<{title, url?}>,
//       reading:       Array<{title, author?, url?}>,
//       exams:         Array<{title, url?}>,
//       labs:          Array<{title, url?}>,
//       final_project: Array<{title, url?}>,
//     },
//     stats: { total_items: number, sections_found: Array<string> },
//     reason?: string
//   }
//
// Implementation: cheerio-first w/ regex fallback. Pure (no fetch/fs). Mirrors
// source-conference-extractor.js architecture so they compose cleanly in the
// lane router pipeline.

let cheerio = null;
try { cheerio = require('cheerio'); } catch (_) { /* fall back to regex path */ }

const COURSE_HOST_PATTERNS = Object.freeze([
  { institution: 'MIT OCW',    re: /(?:^|\.)ocw\.mit\.edu$/i },
  { institution: 'Stanford',   re: /(?:^|\.)stanford\.edu$/i },
  { institution: 'Yale OYC',   re: /(?:^|\.)oyc\.yale\.edu$/i },
  { institution: 'Berkeley',   re: /(?:^|\.)berkeley\.edu$/i },
  { institution: 'CMU',        re: /(?:^|\.)cmu\.edu$/i },
  { institution: 'CMU Eberly', re: /(?:^|\.)cmu\.edu\/teaching$/i },
  { institution: 'Harvard',    re: /(?:^|\.)harvard\.edu$/i },
  { institution: 'OpenStax',   re: /(?:^|\.)openstax\.org$/i },
  { institution: 'Coursera',   re: /(?:^|\.)coursera\.org$/i },
  { institution: 'edX',        re: /(?:^|\.)edx\.org$/i },
]);

const SECTION_KEYWORDS = Object.freeze({
  prerequisites: [/\bprerequisite(s)?\b/i, /\bprior knowledge\b/i, /\brequired background\b/i, /\b先修\b/, /\b前置\b/],
  syllabus:      [/\bsyllabus\b/i, /\bschedule\b/i, /\bcalendar\b/i, /\bcourse outline\b/i, /\bweek[- ]by[- ]week\b/i, /\b教学日历\b/, /\b课程大纲\b/],
  lectures:      [/\blecture(s)?\b/i, /\blecture note(s)?\b/i, /\bclass notes\b/i, /\b课件\b/, /\b讲义\b/],
  assignments:   [/\bassignment(s)?\b/i, /\bhomework\b/i, /\bproblem set(s)?\b/i, /\bpsets?\b/i, /\b作业\b/],
  projects:      [/\bproject(s)?\b/i, /\bgroup project\b/i, /\b课程项目\b/],
  reading:       [/\breading(s)?\b/i, /\btextbook(s)?\b/i, /\brequired reading\b/i, /\brecommended reading\b/i, /\b阅读\b/, /\b教材\b/],
  exams:         [/\bexam(s)?\b/i, /\bmidterm\b/i, /\bquiz(zes)?\b/i, /\b考试\b/, /\b测验\b/],
  labs:          [/\blab(s)?\b/i, /\blaboratory\b/i, /\b实验\b/],
  final_project: [/\bfinal project\b/i, /\bcapstone\b/i, /\bfinal exam\b/i, /\b期末\b/],
});

function _hostnameOf(url) {
  if (typeof url !== 'string') return '';
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

function _detectInstitution(url) {
  const host = _hostnameOf(url);
  if (!host) return null;
  for (const entry of COURSE_HOST_PATTERNS) {
    if (entry.re.test(host)) return entry.institution;
  }
  return null;
}

function _detectCourseId(url) {
  if (typeof url !== 'string') return null;
  // MIT OCW: /courses/6-006-introduction-to-algorithms-spring-2020/
  let m = url.match(/\/courses\/([0-9a-z][\w.-]*?)(?:[\/?#]|$)/i);
  if (m) return m[1];
  // Stanford-style: /class/cs229
  m = url.match(/\/(?:class|courses?)\/([a-z]{2,6}\s*-?\s*\d{1,3}[a-z]?)(?:[\/?#]|$)/i);
  if (m) return m[1].replace(/\s+/g, '');
  // OYC: /courses/spring-2007/phil-181
  m = url.match(/\/courses\/(?:[a-z]+-\d{4}\/)?([a-z]+-\d+)(?:[\/?#]|$)/i);
  if (m) return m[1];
  return null;
}

function _classifySection(headingText) {
  // Order: more specific first (final_project before projects, labs before
  // generic lectures, syllabus before lectures so a "Course Schedule" heading
  // doesn't catch as lectures-only).
  const order = ['final_project', 'prerequisites', 'syllabus', 'labs', 'assignments', 'projects', 'reading', 'exams', 'lectures'];
  for (const field of order) {
    const kws = SECTION_KEYWORDS[field];
    for (const re of kws) {
      if (re.test(headingText)) return field;
    }
  }
  return null;
}

function _weekFromText(text) {
  // Pull a leading "Week 3" / "Lecture 5" / "Lesson 2" / "第三周" marker.
  const m = text.match(/^\s*(?:Week|Lecture|Lesson|Module|Unit)\s+(\d{1,2})\b/i);
  if (m) return parseInt(m[1], 10);
  const cnMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const cn = text.match(/^第\s*([一二三四五六七八九十]{1,2})\s*周/);
  if (cn) {
    let n = 0;
    for (const ch of cn[1]) n = n * 10 + (cnMap[ch] || 0);
    return n > 0 ? n : null;
  }
  return null;
}

function _extractViaCheerio(html) {
  const $ = cheerio.load(html);
  const sectionsFound = new Set();
  const result = _emptyFields();

  const headings = $('h1, h2, h3, h4, header, .section-title, dt');
  headings.each((_, el) => {
    const headingText = $(el).text().trim();
    if (!headingText) return;
    const field = _classifySection(headingText);
    if (!field) return;
    sectionsFound.add(field);
    let node = el.next;
    let safety = 0;
    while (node && safety < 200) {
      safety++;
      const tag = (node.tagName || node.name || '').toLowerCase();
      const $node = $(node);
      if (['h1', 'h2', 'h3', 'h4'].includes(tag)) break;
      if (tag === 'ul' || tag === 'ol') {
        $node.find('li').each((__, li) => {
          const $li = $(li);
          const text = $li.text().trim();
          if (!text) return;
          const anchor = $li.find('a').first();
          const url = anchor.length ? (anchor.attr('href') || null) : null;
          const item = { title: text.slice(0, 300) };
          if (url) item.url = url;
          if (field === 'syllabus') {
            const w = _weekFromText(text);
            if (w !== null) item.week = w;
          }
          result[field].push(item);
        });
      } else if (tag === 'table') {
        $node.find('tr').each((__, tr) => {
          const txt = $(tr).text().trim();
          if (!txt) return;
          if (/^\s*(week|lecture|topic|title|date|due)\s*$/i.test(txt)) return;
          const anchor = $(tr).find('a').first();
          const url = anchor.length ? (anchor.attr('href') || null) : null;
          const item = { title: txt.slice(0, 300) };
          if (url) item.url = url;
          if (field === 'syllabus') {
            const w = _weekFromText(txt);
            if (w !== null) item.week = w;
          }
          result[field].push(item);
        });
      } else if (tag === 'p' || tag === 'div') {
        const text = $node.text().trim();
        if (text && text.length < 400 && /\w/.test(text)) {
          // For prerequisites, paragraph-shaped text is normal.
          if (field === 'prerequisites') {
            result.prerequisites.push({ text: text.slice(0, 400) });
          } else if (text.length < 200) {
            result[field].push({ title: text.slice(0, 300) });
          }
        }
      }
      node = node.next;
    }
  });

  return { items: result, sectionsFound: Array.from(sectionsFound) };
}

function _extractViaRegex(html) {
  const sectionsFound = new Set();
  const result = _emptyFields();
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
      const item = cur.field === 'prerequisites'
        ? { text: text.slice(0, 400) }
        : { title: text.slice(0, 300) };
      if (hrefMatch && cur.field !== 'prerequisites') item.url = hrefMatch[1];
      if (cur.field === 'syllabus') {
        const w = _weekFromText(text);
        if (w !== null) item.week = w;
      }
      result[cur.field].push(item);
    }
  }
  return { items: result, sectionsFound: Array.from(sectionsFound) };
}

function _emptyFields() {
  return {
    prerequisites: [], syllabus: [], lectures: [], assignments: [],
    projects: [], reading: [], exams: [], labs: [], final_project: [],
  };
}

function _countItems(items) {
  let n = 0;
  for (const k of Object.keys(items)) n += items[k].length;
  return n;
}

/**
 * extractCourseFields — parse a course page into structured fields.
 *
 * @param {object} params
 * @param {string} [params.url]   optional URL (institution + course_id detect)
 * @param {string} params.html    HTML to parse (required)
 * @returns {object} structured fields per CONTRACT above
 */
function extractCourseFields(params) {
  const p = params || {};
  if (typeof p.html !== 'string' || p.html.length === 0) {
    return {
      ok: false,
      course_id: null,
      institution: null,
      fields: _emptyFields(),
      stats: { total_items: 0, sections_found: [] },
      reason: 'no html provided',
    };
  }
  const institution = _detectInstitution(p.url);
  const course_id = _detectCourseId(p.url);
  const parsed = cheerio ? _extractViaCheerio(p.html) : _extractViaRegex(p.html);
  return {
    ok: true,
    course_id,
    institution,
    fields: parsed.items,
    stats: {
      total_items: _countItems(parsed.items),
      sections_found: parsed.sectionsFound,
    },
  };
}

module.exports = Object.freeze({
  extractCourseFields,
  COURSE_HOST_PATTERNS,
  SECTION_KEYWORDS,
  _detectInstitution,
  _detectCourseId,
  _classifySection,
  _weekFromText,
});
