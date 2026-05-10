'use strict';
//
// HYPHA · Layer 1 Canonical Curriculum harvest
// =============================================
// Source-of-truth memory:
//   project_hypha_v021_failure_galileo.md  — Galileo opener failure case
//   project_hypha_5layer_scrape_spec.md    — 5-layer source taxonomy
//   feedback_course_gen_info_foundation.md — info acquisition is foundation
//
// PURPOSE
// -------
// Given (topic, archetype, goalContract), identify 2-3 anchor courses on the
// topic from MIT OCW / Stanford / Yale OYC / Berkeley / CMU / OpenStax, scrape
// each one's syllabus, and return a STRUCTURE ANCHOR — canonical lecture order
// + prerequisite chain — that designSeed reads in Phase 2.
//
// WHY this exists
// ---------------
// v0.2.1 ship of HYPHA produced a 哲学 course whose tutor opened at Galileo
// 1633 + Descartes, skipping the pre-Socratics (Thales / Anaximander / etc).
// Root cause: the LLM training-frequency prior puts Descartes/Galileo above
// Thales (more famous → more mentioned → ranked first), and designSeed had
// no external syllabus anchor to counter that bias. Without Layer 1, the
// course is sand-castle no matter how good the styling.
//
// This module is the cure. It provides the canonical lecture sequence the LLM
// must respect — "Lecture 1 = What is philosophy? Lecture 2 = Pre-Socratic
// monists (Thales). Lecture 3 = ..." — so designSeed anchors at Thales not
// Galileo.
//
// CONTRACT
// --------
// Exports `harvestLayer1Canonical({ topic, archetype, goalContract, options })`
// returning `Promise<StructureAnchor>`. See JSDoc on the function for schema.
//
// DEPENDENCIES
// ------------
// - cheerio (1.2.0+, in package.json) — HTML parse
// - node-fetch (in package.json) — HTTP (Node 18+ global fetch also works)
// - app/lib/llm (lazy-required, optional) — only if structured extraction
//   from a non-standard syllabus page is needed; default path is regex+cheerio
//
// CANCEL SUPPORT
// --------------
// Pass options.signal (AbortSignal). Module checks it between each anchor
// fetch and between each lecture-row parse loop. Throws { code: 'CANCELLED' }.

const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
const cheerio = require('cheerio');

// ──────────────────────────────────────────────────────────────────────────
// Anchor map — known-good course pages per (topic-key, archetype)
// ──────────────────────────────────────────────────────────────────────────
//
// Each entry is an array of candidate anchors. The harvest tries each in
// order; the first 2-3 that scrape successfully are kept. URLs point to the
// course HOME page; the syllabus URL is discovered by scraping the home for
// a /syllabus or /lecture-notes / /calendar link, OR derived from a known
// pattern (e.g. MIT OCW courses always carry /pages/syllabus + /pages/calendar).
//
// Topic keys are NORMALIZED — see normalizeTopicKey() below — so 哲学 /
// philosophy / phil / 哲学史 all map to "philosophy".

const ANCHOR_MAP = {
  // ── HUMANISTIC ──
  philosophy: [
    // Yale OYC PHIL 181 — has 26 lectures with clean "Lecture N. <Title>" sequence
    {
      title: 'Yale OYC PHIL 181 — Philosophy and the Science of Human Nature',
      source: 'Yale OYC',
      url: 'https://oyc.yale.edu/philosophy/phil-181',
      kind: 'oyc',
    },
    // History-of-Western-philosophy specific — STARTS at Socrates / Plato
    // (canonical syllabus order). 2026-05-09 verified live.
    {
      title: 'MIT OCW 24.01 — Classics of Western Philosophy',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/24-01-classics-of-western-philosophy-spring-2016/',
      kind: 'ocw',
    },
    {
      title: 'Yale OYC PHIL 176 — Death',
      source: 'Yale OYC',
      url: 'https://oyc.yale.edu/death/phil-176',
      kind: 'oyc',
    },
  ],

  literature: [
    {
      title: 'Yale OYC ENGL 220 — Milton',
      source: 'Yale OYC',
      url: 'https://oyc.yale.edu/english/engl-220',
      kind: 'oyc',
    },
    {
      title: 'Yale OYC ENGL 291 — The American Novel Since 1945',
      source: 'Yale OYC',
      url: 'https://oyc.yale.edu/english/engl-291',
      kind: 'oyc',
    },
    {
      title: 'MIT OCW 21L.001 — Foundations of Western Literature',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/21l-001-foundations-of-western-literature-homer-to-dante-fall-2012/',
      kind: 'ocw',
    },
  ],

  history: [
    {
      title: 'Yale OYC HIST 116 — The American Revolution',
      source: 'Yale OYC',
      url: 'https://oyc.yale.edu/history/hist-116',
      kind: 'oyc',
    },
    {
      title: 'Yale OYC HIST 234 — Epidemics in Western Society Since 1600',
      source: 'Yale OYC',
      url: 'https://oyc.yale.edu/history/hist-234',
      kind: 'oyc',
    },
  ],

  // ── TECH-CONCEPT ──
  'deep-learning': [
    {
      title: 'Stanford CS231n — Deep Learning for Computer Vision',
      source: 'Stanford',
      url: 'https://cs231n.stanford.edu/',
      kind: 'stanford-html',
    },
    {
      title: 'MIT 6.S191 — Introduction to Deep Learning',
      source: 'MIT',
      url: 'http://introtodeeplearning.com/',
      kind: 'generic-html',
    },
    {
      title: 'Stanford CS224n — Natural Language Processing with Deep Learning',
      source: 'Stanford',
      url: 'https://web.stanford.edu/class/cs224n/',
      kind: 'stanford-html',
    },
  ],

  'machine-learning': [
    {
      title: 'Stanford CS229 — Machine Learning',
      source: 'Stanford',
      url: 'https://cs229.stanford.edu/',
      kind: 'stanford-html',
    },
    {
      title: 'MIT OCW 6.036 — Introduction to Machine Learning',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/6-036-introduction-to-machine-learning-fall-2020/',
      kind: 'ocw',
    },
  ],

  programming: [
    {
      title: 'Berkeley CS61A — Structure and Interpretation of Computer Programs',
      source: 'UC Berkeley',
      url: 'https://cs61a.org/',
      kind: 'generic-html',
    },
    {
      title: 'MIT OCW 6.0001 — Introduction to Computer Science and Programming',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/6-0001-introduction-to-computer-science-and-programming-in-python-fall-2016/',
      kind: 'ocw',
    },
  ],

  algorithms: [
    {
      title: 'MIT OCW 6.006 — Introduction to Algorithms',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/6-006-introduction-to-algorithms-spring-2020/',
      kind: 'ocw',
    },
    {
      title: 'Stanford CS161 — Design and Analysis of Algorithms',
      source: 'Stanford',
      url: 'https://stanford-cs161.github.io/winter2024/',
      kind: 'generic-html',
    },
  ],

  // ── MATH-PHYSICS ──
  'linear-algebra': [
    {
      title: 'MIT OCW 18.06 — Linear Algebra',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/',
      kind: 'ocw',
    },
    {
      title: 'MIT OCW 18.065 — Matrix Methods in Data Analysis',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/18-065-matrix-methods-in-data-analysis-signal-processing-and-machine-learning-spring-2018/',
      kind: 'ocw',
    },
  ],

  calculus: [
    {
      title: 'MIT OCW 18.01 — Single Variable Calculus',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/18-01-single-variable-calculus-fall-2006/',
      kind: 'ocw',
    },
    {
      title: 'MIT OCW 18.02 — Multivariable Calculus',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/18-02-multivariable-calculus-fall-2007/',
      kind: 'ocw',
    },
  ],

  physics: [
    {
      title: 'MIT OCW 8.01 — Classical Mechanics',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/8-01sc-classical-mechanics-fall-2016/',
      kind: 'ocw',
    },
    {
      title: 'MIT OCW 8.02 — Electricity and Magnetism',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/8-02-physics-ii-electricity-and-magnetism-spring-2007/',
      kind: 'ocw',
    },
  ],

  economics: [
    {
      title: 'Yale OYC ECON 159 — Game Theory',
      source: 'Yale OYC',
      url: 'https://oyc.yale.edu/economics/econ-159',
      kind: 'oyc',
    },
    {
      title: 'MIT OCW 14.01 — Principles of Microeconomics',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/14-01sc-principles-of-microeconomics-fall-2011/',
      kind: 'ocw',
    },
  ],

  psychology: [
    {
      title: 'Yale OYC PSYC 110 — Introduction to Psychology',
      source: 'Yale OYC',
      url: 'https://oyc.yale.edu/psychology/psyc-110',
      kind: 'oyc',
    },
    {
      title: 'MIT OCW 9.00 — Introduction to Psychology',
      source: 'MIT OCW',
      url: 'https://ocw.mit.edu/courses/9-00sc-introduction-to-psychology-fall-2011/',
      kind: 'ocw',
    },
  ],
};

// Topic-key normalization — map raw topic + archetype to one of ANCHOR_MAP's
// keys. CN aliases included for the cases the v0.2.1 user actually triggered.
const TOPIC_ALIASES = {
  // philosophy
  '哲学':              'philosophy',
  '哲学史':            'philosophy',
  '西方哲学':          'philosophy',
  '西方哲学史':        'philosophy',
  'philosophy':         'philosophy',
  'phil':               'philosophy',
  'history of philosophy': 'philosophy',
  'western philosophy': 'philosophy',

  // literature
  '文学':              'literature',
  '文学批评':          'literature',
  'literature':         'literature',
  'literary analysis':  'literature',

  // history
  '历史':              'history',
  'history':            'history',

  // deep learning
  '深度学习':          'deep-learning',
  'deep learning':      'deep-learning',
  'deep-learning':      'deep-learning',
  'dl':                 'deep-learning',
  'neural networks':    'deep-learning',
  '神经网络':          'deep-learning',

  // machine learning
  '机器学习':          'machine-learning',
  'machine learning':   'machine-learning',
  'machine-learning':   'machine-learning',
  'ml':                 'machine-learning',

  // programming
  '编程':              'programming',
  '程序设计':          'programming',
  'programming':        'programming',
  'cs':                 'programming',
  'computer science':   'programming',

  // algorithms
  '算法':              'algorithms',
  'algorithms':         'algorithms',
  'algorithm':          'algorithms',
  'data structures and algorithms': 'algorithms',

  // linear algebra
  '线性代数':          'linear-algebra',
  'linear algebra':     'linear-algebra',
  'linear-algebra':     'linear-algebra',

  // calculus
  '微积分':            'calculus',
  'calculus':           'calculus',
  '高等数学':          'calculus',

  // physics
  '物理':              'physics',
  '物理学':            'physics',
  'physics':            'physics',
  'classical mechanics': 'physics',

  // economics
  '经济学':            'economics',
  'economics':          'economics',
  'microeconomics':     'economics',
  'game theory':        'economics',

  // psychology
  '心理学':            'psychology',
  'psychology':         'psychology',
};

function normalizeTopicKey(topic) {
  if (!topic) return null;
  const raw = String(topic).trim();
  const lowered = raw.toLowerCase();
  if (TOPIC_ALIASES[lowered]) return TOPIC_ALIASES[lowered];
  // try the original (CN inputs have no case to lower)
  if (TOPIC_ALIASES[raw]) return TOPIC_ALIASES[raw];
  // last-ditch substring match (longest alias first to avoid early collisions)
  const aliases = Object.keys(TOPIC_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (lowered.includes(alias.toLowerCase()) || raw.includes(alias)) {
      return TOPIC_ALIASES[alias];
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Cancel + fetch helpers
// ──────────────────────────────────────────────────────────────────────────

function checkCancel(signal) {
  if (signal && signal.aborted) {
    const err = new Error('Layer 1 harvest cancelled');
    err.code = 'CANCELLED';
    throw err;
  }
}

async function fetchHtml(url, { timeoutMs = 15000, signal } = {}) {
  checkCancel(signal);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let onAbort = null;
  try {
    const headers = {
      'User-Agent': 'Hypha/0.3 layer1-canonical-harvest (educational research)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (signal) {
      // chain external abort → internal controller
      onAbort = () => { try { ctrl.abort(); } catch (_) { /* ignore */ } };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const res = await fetchFn(url, { headers, signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const text = await res.text();
    return text;
  } finally {
    clearTimeout(t);
    if (signal && onAbort) {
      try { signal.removeEventListener('abort', onAbort); } catch (_) { /* ignore */ }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// OCW scraper — MIT OpenCourseWare lecture extraction
// ──────────────────────────────────────────────────────────────────────────
//
// MIT OCW courses (2020+ rebuild) are React-rendered SPAs but lecture lists
// also appear in the HTML for legacy pages. The reliable scrape paths:
//   1. Calendar page: <courseUrl>/pages/calendar — table of lecture # / topic
//   2. Lecture-notes page: <courseUrl>/pages/lecture-notes — list of lectures
//   3. Syllabus page: <courseUrl>/pages/syllabus — text summary + reading list
//
// We try each in order, keep whichever yields a non-empty LectureSequence.

async function scrapeOcw(anchor, opts) {
  const baseUrl = anchor.url.replace(/\/$/, '');
  const tryPaths = [
    '/pages/calendar/',
    '/pages/lecture-notes/',
    '/pages/lecture-videos/',
    '/pages/syllabus/',
    '/pages/readings/',
  ];

  let syllabusText = '';
  let syllabusUrl = '';
  let lectureSequence = [];

  for (const p of tryPaths) {
    checkCancel(opts.signal);
    const url = baseUrl + p;
    let html;
    try {
      html = await fetchHtml(url, opts);
    } catch (_) {
      continue;
    }
    const $ = cheerio.load(html);
    // Pull course main content, strip nav/footer
    const main = $('main').length ? $('main') : $('body');
    const text = main.text().replace(/\s+/g, ' ').trim();
    if (!syllabusText && text.length > 200) {
      syllabusText = text.slice(0, 8000);
      syllabusUrl = url;
    }
    // Calendar / lecture-notes pages have <table> rows or <li> items with
    // "Lec N: <Topic>" patterns.
    const seq = extractLecturesFromOcwPage($);
    if (seq.length > lectureSequence.length) {
      lectureSequence = seq;
    }
    if (lectureSequence.length >= 6) break;
  }

  return {
    title: anchor.title,
    source: anchor.source,
    url: baseUrl + '/',
    syllabusUrl,
    syllabusText,
    lectureSequence,
    terms_offered: extractTermFromUrl(baseUrl),
  };
}

function extractLecturesFromOcwPage($) {
  const seq = [];

  // Pattern A: <table> with Lec # / Topics columns (calendar page)
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const c0 = $(cells[0]).text().trim();
    const c1 = $(cells[1]).text().trim();
    // Match "L1" / "Lec 1" / "1" + topic
    const lecNumMatch = c0.match(/^(?:lec(?:ture)?\.?\s*)?(\d{1,3})[a-z]?$/i);
    if (lecNumMatch && c1.length > 2 && c1.length < 250) {
      seq.push({
        idx: parseInt(lecNumMatch[1], 10),
        title: c1.replace(/\s+/g, ' '),
        week: null,
        topic_summary: '',
        prerequisite_idxs: [],
      });
    }
  });

  if (seq.length >= 4) return dedupAndSortLectures(seq);

  // Pattern B: <ol>/<ul> of lecture links (lecture-notes / lecture-videos)
  $('a').each((_, a) => {
    const t = $(a).text().trim();
    const m = t.match(/^(?:Lecture|Lec\.?)\s*(\d{1,3})\s*[:\-—]\s*(.+)$/i);
    if (m) {
      seq.push({
        idx: parseInt(m[1], 10),
        title: m[2].trim().slice(0, 200),
        week: null,
        topic_summary: '',
        prerequisite_idxs: [],
      });
    }
  });

  return dedupAndSortLectures(seq);
}

function extractTermFromUrl(url) {
  const m = url.match(/(spring|fall|winter|summer)-(\d{4})/i);
  return m ? `${m[1]} ${m[2]}` : '';
}

// ──────────────────────────────────────────────────────────────────────────
// Yale OYC scraper — OpenYale Courses
// ──────────────────────────────────────────────────────────────────────────
//
// OYC has a regular static structure: each course page has a "Sessions" or
// "Schedule" section listing 24 lectures with titles. Scrape the course
// landing page; the lecture list appears in <a>/<li>/<td> nodes formatted as
// "Lecture N. <Title>".

async function scrapeOyc(anchor, opts) {
  const url = anchor.url;
  const html = await fetchHtml(url, opts);
  const $ = cheerio.load(html);

  let lectureSequence = [];

  // Pattern A: OYC's session-list — each row labeled "Lecture N. <Title>"
  $('a, li, td').each((_, el) => {
    const t = $(el).text().trim();
    const m = t.match(/^Lecture\s+(\d{1,3})\.?\s*(.+)$/i);
    if (m && m[2].length > 2 && m[2].length < 200) {
      lectureSequence.push({
        idx: parseInt(m[1], 10),
        title: m[2].trim(),
        week: null,
        topic_summary: '',
        prerequisite_idxs: [],
      });
    }
  });

  lectureSequence = dedupAndSortLectures(lectureSequence);

  // Pull syllabus / overview text from main content
  const main = $('#content, .content, main, article').first();
  const syllabusText = (main.length ? main.text() : $('body').text())
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);

  return {
    title: anchor.title,
    source: anchor.source,
    url,
    syllabusUrl: url,
    syllabusText,
    lectureSequence,
    terms_offered: '',
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Stanford / generic course-site scraper
// ──────────────────────────────────────────────────────────────────────────
//
// Stanford CS courses (cs231n / cs229 / cs224n) host their syllabus on
// /syllabus.html or directly on the home page as a <table>. CMU / Berkeley
// follow similar patterns. We use a generic "find lecture rows in tables and
// in lecture-* links" heuristic.

async function scrapeGenericCourseSite(anchor, opts) {
  const baseUrl = anchor.url.replace(/\/$/, '');
  const tryPaths = ['/syllabus.html', '/schedule.html', '/calendar.html', '/'];

  let html = '';
  let syllabusUrl = '';
  for (const p of tryPaths) {
    checkCancel(opts.signal);
    try {
      html = await fetchHtml(baseUrl + p, opts);
      syllabusUrl = baseUrl + p;
      if (html.length > 500) break;
    } catch (_) { /* try next */ }
  }
  if (!html) {
    return {
      title: anchor.title,
      source: anchor.source,
      url: anchor.url,
      syllabusUrl: '',
      syllabusText: '',
      lectureSequence: [],
      terms_offered: '',
    };
  }

  const $ = cheerio.load(html);
  let lectureSequence = [];

  // Pattern A: table with lecture rows
  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    let lecIdx = null;
    let lecTitle = '';
    cells.each((_i, c) => {
      const txt = $(c).text().trim();
      const numericLecMatch =
        txt.match(/^(?:Lecture|Lec\.?)\s*(\d{1,3})$/i)
        || txt.match(/^L(\d{1,3})$/i)
        || (lecIdx === null && txt.match(/^(\d{1,2})$/));
      if (numericLecMatch && lecIdx === null) {
        lecIdx = parseInt(numericLecMatch[1], 10);
        return;
      }
      // first non-numeric long cell after lec idx = title
      if (lecIdx !== null && !lecTitle && txt.length > 3 && txt.length < 250
          && !/^\d+$/.test(txt) && !/^(Mon|Tue|Wed|Thu|Fri)/i.test(txt)) {
        lecTitle = txt;
      }
    });
    if (lecIdx !== null && lecTitle) {
      lectureSequence.push({
        idx: lecIdx,
        title: lecTitle,
        week: null,
        topic_summary: '',
        prerequisite_idxs: [],
      });
    }
  });

  // Pattern B: anchor "Lecture N: Title"
  if (lectureSequence.length < 4) {
    $('a, li, h3, h4').each((_, el) => {
      const t = $(el).text().trim();
      const m = t.match(/^(?:Lecture|Lec\.?)\s*(\d{1,3})\s*[:\-—.]\s*(.+)$/i);
      if (m && m[2].length > 2 && m[2].length < 250) {
        lectureSequence.push({
          idx: parseInt(m[1], 10),
          title: m[2].trim(),
          week: null,
          topic_summary: '',
          prerequisite_idxs: [],
        });
      }
    });
  }

  lectureSequence = dedupAndSortLectures(lectureSequence);

  const main = $('main, #main, .main, body').first();
  const syllabusText = main.text().replace(/\s+/g, ' ').trim().slice(0, 8000);

  return {
    title: anchor.title,
    source: anchor.source,
    url: anchor.url,
    syllabusUrl,
    syllabusText,
    lectureSequence,
    terms_offered: '',
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Lecture utilities
// ──────────────────────────────────────────────────────────────────────────

function dedupAndSortLectures(seq) {
  // Remove duplicate idx, sort by idx.
  const byIdx = new Map();
  for (const l of seq) {
    if (!Number.isFinite(l.idx)) continue;
    const existing = byIdx.get(l.idx);
    if (!existing || existing.title.length < l.title.length) {
      byIdx.set(l.idx, l);
    }
  }
  return Array.from(byIdx.values()).sort((a, b) => a.idx - b.idx);
}

// Merge sequences from multiple anchors. Strategy: pick the longest sequence
// as the spine, then backfill any idxs missing in the spine but present in
// another anchor. Disagreements on title at same idx are not surfaced as
// warnings here (would clutter output) — confidence dilution is the signal.
function mergeLectureSequences(byAnchor) {
  let spine = [];
  for (const seq of byAnchor) {
    if (seq.length > spine.length) spine = seq.slice();
  }
  if (spine.length === 0) return [];

  const haveIdx = new Set(spine.map(l => l.idx));
  for (const seq of byAnchor) {
    for (const l of seq) {
      if (!haveIdx.has(l.idx)) {
        spine.push(l);
        haveIdx.add(l.idx);
      }
    }
  }
  return spine.sort((a, b) => a.idx - b.idx);
}

// ──────────────────────────────────────────────────────────────────────────
// Prerequisite-chain extraction (heuristic + optional LLM)
// ──────────────────────────────────────────────────────────────────────────
//
// A real prerequisite chain (concept-level DAG) needs LLM extraction over
// the syllabus_text + lecture titles. We attempt a cheap heuristic first
// (each lecture depends on its immediate predecessor — sound for sequential
// canonical curricula). If options.useLlmForPrereq is true (default) AND
// syllabus_text is non-trivial, we call T3_MID for richer concept-level
// edges. LLM call is gated behind a try/catch so smoke tests, offline
// sessions, and provider outages all fall back to heuristic.

async function extractPrerequisiteChain(lectureSequence, syllabusText, opts) {
  if (lectureSequence.length === 0) return [];

  // Stage 1: heuristic — each lecture depends on its immediate predecessor
  const heuristic = lectureSequence.map((lec, i) => ({
    concept: lec.title,
    prerequisites: i > 0 ? [lectureSequence[i - 1].title] : [],
    introduces: [lec.title],
  }));

  if (opts.useLlmForPrereq === false || !syllabusText || syllabusText.length < 400) {
    return heuristic;
  }

  // Stage 2: LLM concept-level extraction
  let llmEdges = [];
  try {
    // Lazy require to avoid circular boot — llm/index.js does provider init
    const llm = require('../llm');
    if (!llm || typeof llm.executeChat !== 'function') return heuristic;

    const titles = lectureSequence.slice(0, 30).map(l => `${l.idx}. ${l.title}`).join('\n');
    const sys = 'You extract prerequisite chains from course syllabi. '
      + 'Output STRICT JSON: {"edges":[{"concept":"<topic>","prerequisites":["<earlier topic>"]}]}. '
      + 'Use the exact lecture titles. List up to 12 edges. No prose, no markdown.';
    const usr = `Course lectures (in order):\n${titles}\n\n`
      + `Syllabus excerpt:\n${syllabusText.slice(0, 2400)}\n\n`
      + `Extract concept prerequisite edges. Each edge: which earlier lecture must be known to follow which later lecture.`;

    const res = await llm.executeChat('T3_MID', {
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: usr },
      ],
      json: true,
      maxTokens: 800,
      temperature: 0,
    });

    // executeChat returns { result, providerId, model, capability, attempts }
    // result shape varies per provider — accept content / text / message.content
    const txt = extractTextFromLlmResult(res);
    const parsed = safeJsonParse(txt);
    if (parsed && Array.isArray(parsed.edges)) {
      llmEdges = parsed.edges.filter(e => e
        && typeof e.concept === 'string'
        && Array.isArray(e.prerequisites));
    }
  } catch (_) { /* LLM unavailable / blew up — heuristic suffices */ }

  if (llmEdges.length >= 3) {
    return llmEdges.map(e => ({
      concept: e.concept,
      prerequisites: e.prerequisites,
      introduces: [e.concept],
    }));
  }
  return heuristic;
}

function extractTextFromLlmResult(res) {
  if (!res) return '';
  const r = res.result || res;
  if (typeof r === 'string') return r;
  if (r && typeof r.content === 'string') return r.content;
  if (r && typeof r.text === 'string') return r.text;
  if (r && r.message && typeof r.message.content === 'string') return r.message.content;
  if (r && Array.isArray(r.choices) && r.choices[0]
      && r.choices[0].message && typeof r.choices[0].message.content === 'string') {
    return r.choices[0].message.content;
  }
  return '';
}

function safeJsonParse(s) {
  if (!s) return null;
  // Strip ```json / ``` fences if present
  const cleaned = String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }
  // try to extract first {...} block
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) { return null; }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// Confidence scoring
// ──────────────────────────────────────────────────────────────────────────

function scoreConfidence(anchorCourses, lectureSequence) {
  if (anchorCourses.length === 0 || lectureSequence.length === 0) return 0;
  let s = 0.3;                                              // base for any extraction
  if (anchorCourses.length >= 2) s += 0.2;                  // multiple anchors agree
  if (anchorCourses.length >= 3) s += 0.1;
  if (lectureSequence.length >= 8) s += 0.2;                // substantial sequence
  if (lectureSequence.length >= 16) s += 0.1;
  // bonus: idxs are dense (1..N with few gaps) — strong signal of clean parse
  const idxs = lectureSequence.map(l => l.idx).filter(Number.isFinite);
  if (idxs.length > 0) {
    const span = Math.max(...idxs) - Math.min(...idxs) + 1;
    const density = idxs.length / span;
    if (density >= 0.8) s += 0.1;
  }
  return Math.min(1, s);
}

// ──────────────────────────────────────────────────────────────────────────
// Main entry: harvestLayer1Canonical
// ──────────────────────────────────────────────────────────────────────────

/**
 * Identify 2-3 anchor courses on the topic + scrape each one's syllabus.
 * Returns structureAnchor for designSeed.
 *
 * @param {object} args
 * @param {string} args.topic           — e.g. "哲学", "深度学习", "线性代数"
 * @param {string} args.archetype       — TECH-CONCEPT / HUMANISTIC / MATH-PHYSICS / etc
 * @param {object} [args.goalContract]  — north_star_goal / current_level
 * @param {object} [args.options]
 * @param {number} [args.options.timeoutMs=120000]  — total budget (ms)
 * @param {number} [args.options.perFetchTimeoutMs=15000] — single HTTP timeout
 * @param {AbortSignal} [args.options.signal]       — for cancel
 * @param {boolean} [args.options.useLlmForPrereq=true] — set false in smoke tests
 * @param {number}  [args.options.maxAnchors=3]     — cap anchors scraped
 * @returns {Promise<StructureAnchor>}
 *
 * StructureAnchor = {
 *   anchorCourses: [
 *     { title, source, url, terms_offered, syllabusUrl, syllabus_text }
 *   ],
 *   lectureSequence: [
 *     { idx, title, week, topic_summary, prerequisite_idxs }
 *   ],
 *   prerequisiteChain: [
 *     { concept, prerequisites: [<concept>], introduces: [<concept>] }
 *   ],
 *   confidence: 0..1,
 *   warnings: [string],
 * }
 */
async function harvestLayer1Canonical(args) {
  const { topic, archetype } = args || {};
  const opts = Object.assign({
    timeoutMs: 120000,
    perFetchTimeoutMs: 15000,
    useLlmForPrereq: true,
    maxAnchors: 3,
  }, (args && args.options) || {});

  const warnings = [];
  if (!topic || typeof topic !== 'string') {
    return {
      anchorCourses: [],
      lectureSequence: [],
      prerequisiteChain: [],
      confidence: 0,
      warnings: ['topic missing or not a string'],
    };
  }

  const startedAt = Date.now();
  const overallSignal = opts.signal;

  const key = normalizeTopicKey(topic);
  if (!key || !ANCHOR_MAP[key]) {
    warnings.push(`no canonical anchor for topic "${topic}" (archetype=${archetype || '_'}); Layer 1 returns empty`);
    return {
      anchorCourses: [],
      lectureSequence: [],
      prerequisiteChain: [],
      confidence: 0,
      warnings,
    };
  }

  const candidates = ANCHOR_MAP[key].slice(0, Math.max(opts.maxAnchors + 2, 3));
  const scraped = [];
  const lectureSeqs = [];

  for (const cand of candidates) {
    if (scraped.length >= opts.maxAnchors) break;
    if (Date.now() - startedAt > opts.timeoutMs) {
      warnings.push(`timeoutMs=${opts.timeoutMs} exceeded; stopped at ${scraped.length} anchors`);
      break;
    }
    checkCancel(overallSignal);

    let result = null;
    try {
      const fetchOpts = { signal: overallSignal, timeoutMs: opts.perFetchTimeoutMs };
      if (cand.kind === 'ocw') result = await scrapeOcw(cand, fetchOpts);
      else if (cand.kind === 'oyc') result = await scrapeOyc(cand, fetchOpts);
      else result = await scrapeGenericCourseSite(cand, fetchOpts);
    } catch (e) {
      if (e && e.code === 'CANCELLED') throw e;
      warnings.push(`scrape failed for ${cand.title}: ${e && e.message ? e.message : 'unknown'}`);
      continue;
    }

    if (!result || !result.lectureSequence || result.lectureSequence.length === 0) {
      warnings.push(`no lectures extracted from ${cand.title} (${cand.url})`);
      // Still record the anchor (the title + URL is value) but with empty sequence
      scraped.push({
        title: cand.title,
        source: cand.source,
        url: cand.url,
        terms_offered: result ? (result.terms_offered || '') : '',
        syllabusUrl: result ? (result.syllabusUrl || '') : '',
        syllabus_text: result ? (result.syllabusText || '') : '',
      });
      continue;
    }

    scraped.push({
      title: result.title,
      source: result.source,
      url: result.url,
      terms_offered: result.terms_offered || '',
      syllabusUrl: result.syllabusUrl || '',
      syllabus_text: result.syllabusText || '',
    });
    lectureSeqs.push(result.lectureSequence);
  }

  if (scraped.length === 0) {
    return {
      anchorCourses: [],
      lectureSequence: [],
      prerequisiteChain: [],
      confidence: 0,
      warnings: warnings.concat([`all ${candidates.length} anchor candidates failed for topic key "${key}"`]),
    };
  }

  // Merge lecture sequences from successful scrapes
  const merged = mergeLectureSequences(lectureSeqs);

  // Wire intra-course prerequisite_idxs (each lecture depends on its predecessor)
  for (let i = 0; i < merged.length; i++) {
    if (i > 0) merged[i].prerequisite_idxs = [merged[i - 1].idx];
  }

  // Concept-level prerequisite chain (LLM-augmented when available)
  const longestSyllabusText = scraped
    .map(s => s.syllabus_text || '')
    .reduce((acc, t) => (t.length > acc.length ? t : acc), '');

  let prerequisiteChain = [];
  try {
    prerequisiteChain = await extractPrerequisiteChain(merged, longestSyllabusText, opts);
  } catch (e) {
    if (e && e.code === 'CANCELLED') throw e;
    warnings.push(`prereq extraction error: ${e && e.message ? e.message : 'unknown'}`);
  }

  const confidence = scoreConfidence(scraped, merged);
  if (merged.length === 0) {
    warnings.push('all anchors scraped but lecture sequence is empty (anchor pages may have changed structure)');
  } else if (confidence < 0.5) {
    warnings.push(`low confidence ${confidence.toFixed(2)} — fewer anchors / shorter sequence than ideal`);
  }

  return {
    anchorCourses: scraped,
    lectureSequence: merged,
    prerequisiteChain,
    confidence,
    warnings,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────────

module.exports = {
  harvestLayer1Canonical,
  // Exposed for tests / debugging:
  _normalizeTopicKey: normalizeTopicKey,
  _ANCHOR_MAP: ANCHOR_MAP,
  _scrapeOcw: scrapeOcw,
  _scrapeOyc: scrapeOyc,
  _scrapeGenericCourseSite: scrapeGenericCourseSite,
  _mergeLectureSequences: mergeLectureSequences,
  _scoreConfidence: scoreConfidence,
};
