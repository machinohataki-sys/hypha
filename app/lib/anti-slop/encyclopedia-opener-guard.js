'use strict';

// HYPHA · Anti-Slop · Encyclopedia-Opener Guard (rc.1 → 1.0)
//
// Strengthens the existing HOOK_ABSTRACT_RE in lesson-body-generator.js with a
// broader regex bank. The body validator already flags one shape; this module
// catalogues the full set of dictionary / textbook / meta-textbook openers
// that have leaked through in production and gives the schema-retry loop a
// concrete error message identifying which anti-pattern fired.
//
// Three anti-pattern families:
//   1. DICTIONARY    — "X 是一个 Y" / "X 指 Y" / "X is a kind of Y"
//                      Straight definitional form, no concrete entry-point.
//   2. ACADEMIC      — "X has been studied for ..." / "X 长期以来 ..."
//                      Textbook framing, no specific scene.
//   3. META_TEXTBOOK — "In this lesson we will learn ..." / "本课介绍 ..."
//                      Teacher-talking-about-teaching, breaks the 4th wall.
//
// Each pattern includes Chinese + English variants. Patterns are anchored to
// the FIRST 120 chars of the opener (intro_hook_scene OR canonical_example)
// so a later sentence using these phrases naturally is not penalized.
//
// Pure function; no LLM. The rewriter chain in prosecute-judge-rewrite.js owns
// the auto-rewrite — this module only DETECTS and labels.

// Each entry: { id, family, pattern, label }
// pattern.test(opener_first_120_chars) → fires.
const PATTERN_BANK = [
  // ── DICTIONARY family ──────────────────────────────────────────────────
  // "X 是一个 Y" / "X 是一种 Y" / "X 即 Y" — straight definitional copula.
  { id: 'cn_shi_yige', family: 'DICTIONARY',
    pattern: /^.{1,30}?\s*是\s*(一个|一种|一类|某种|某个)\s*/,
    label: '中文 "X 是一个/一种 Y" 字典式开场' },
  { id: 'cn_zhi', family: 'DICTIONARY',
    pattern: /^.{1,30}?\s*(指的是|指代|意指|意为|定义为)\s*/,
    label: '中文 "X 指/定义为 Y" 字典式开场' },
  { id: 'cn_jiushi', family: 'DICTIONARY',
    pattern: /^.{1,30}?\s*就是\s*(指|说)\s*/,
    label: '中文 "X 就是指/说 Y" 字典式开场' },
  { id: 'en_is_a_kind', family: 'DICTIONARY',
    pattern: /^[\w\s]{1,40}?\s+is\s+(a|an|the)\s+(kind|type|form|class|category)\s+of\s+/i,
    label: 'English "X is a kind/type/form of Y" dictionary opener' },
  { id: 'en_refers_to', family: 'DICTIONARY',
    pattern: /^[\w\s]{1,40}?\s+(refers?\s+to|denotes?|means?|is\s+defined\s+as)\s+/i,
    label: 'English "X refers to / is defined as Y" dictionary opener' },

  // ── ACADEMIC family ────────────────────────────────────────────────────
  // "X has been studied for ..." / "X 长期以来 ..." / "X 自古以来 ..."
  { id: 'cn_changqi', family: 'ACADEMIC',
    pattern: /^.{0,40}?\s*(长期以来|自古以来|历来|自始至终|从古至今)\s*/,
    label: '中文 "长期以来/自古以来" 学术教科书开场' },
  { id: 'cn_shiyan_yanjiu', family: 'ACADEMIC',
    pattern: /^.{0,40}?\s*(被广泛|被深入|一直被|多年来.{0,8}?(研究|讨论|关注))\s*/,
    label: '中文 "被广泛研究/多年来研究" 教科书铺垫' },
  { id: 'en_studied_for', family: 'ACADEMIC',
    pattern: /^[\w\s,]{0,60}?(has|have)\s+been\s+(studied|researched|investigated|discussed|debated)\s+(for|since|extensively)/i,
    label: 'English "X has been studied for ..." academic opener' },
  { id: 'en_throughout_history', family: 'ACADEMIC',
    pattern: /^(throughout\s+history|since\s+antiquity|for\s+centuries|over\s+the\s+years)/i,
    label: 'English "Throughout history / Since antiquity" academic opener' },

  // ── META_TEXTBOOK family ───────────────────────────────────────────────
  // "In this lesson we will learn ..." / "本课介绍 ..." / "本节讨论 ..."
  { id: 'cn_benke', family: 'META_TEXTBOOK',
    pattern: /^(本(课|节|章)|这(一)?(课|节|章))\s*(介绍|讨论|讲解|探讨|学习|教|说明|讲述|聚焦|涉及)\s*/,
    label: '中文 "本课/本节 介绍/讨论 ..." 元教科书开场' },
  { id: 'cn_women_jiang', family: 'META_TEXTBOOK',
    pattern: /^(我们|让我们|大家)\s*(将|要|来|一起|今天)?\s*(学习|讨论|探讨|介绍|看看|了解)/,
    label: '中文 "我们今天要学习/讨论 ..." 元教科书开场' },
  { id: 'en_in_this_lesson', family: 'META_TEXTBOOK',
    pattern: /^(in\s+this\s+(lesson|chapter|section|module|unit)|today\s+we['']ll|today\s+we\s+will|we\s+will\s+(learn|explore|discuss|cover|examine))/i,
    label: 'English "In this lesson we will learn ..." meta-textbook opener' },
  { id: 'en_welcome_to', family: 'META_TEXTBOOK',
    pattern: /^welcome\s+to\s+(this|the)\s+(lesson|chapter|module|course)/i,
    label: 'English "Welcome to this lesson" meta-textbook opener' },
  { id: 'en_introduction_to', family: 'META_TEXTBOOK',
    pattern: /^(an?\s+)?(introduction\s+to|overview\s+of|brief\s+overview\s+of|exploration\s+of|survey\s+of)\s+/i,
    label: 'English "Introduction to / An overview of" meta-textbook opener' },
];

const OPENER_SCAN_CHARS = 120;

function _firstChars(s) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, OPENER_SCAN_CHARS);
}

function scanOpener(text) {
  const opener = _firstChars(text);
  if (!opener) return { fired: false, hits: [] };
  const hits = [];
  for (const p of PATTERN_BANK) {
    try {
      if (p.pattern.test(opener)) {
        hits.push({ id: p.id, family: p.family, label: p.label });
      }
    } catch (_) { /* defensive — bad regex never crashes scan */ }
  }
  return { fired: hits.length > 0, hits };
}

// Inspect a v0.2+ lesson body's hook fields (intro_hook_scene, canonical_example).
// Returns { fired, hits, field_scanned }.
function scanLessonBody(body) {
  if (!body || typeof body !== 'object') return { fired: false, hits: [], field_scanned: null };
  const intro = typeof body.intro_hook_scene === 'string' && body.intro_hook_scene.trim()
    ? body.intro_hook_scene
    : null;
  const canon = typeof body.canonical_example === 'string' && body.canonical_example.trim()
    ? body.canonical_example
    : null;
  // intro_hook_scene takes precedence — it's the explicit opener field.
  const field = intro ? 'intro_hook_scene' : (canon ? 'canonical_example' : null);
  const text = intro || canon || '';
  const result = scanOpener(text);
  return Object.assign({}, result, { field_scanned: field });
}

// Build a regen-feedback string for the schema-retry loop in
// lesson-body-generator.js. Caller uses this to append a precise feedback
// message identifying the family + sample anti-pattern that fired.
function buildRegenFeedback(scanResult) {
  if (!scanResult || !scanResult.fired) return null;
  const families = Array.from(new Set(scanResult.hits.map(h => h.family)));
  const sampleLabels = scanResult.hits.slice(0, 3).map(h => `  - ${h.label}`).join('\n');
  return `OPENER ANTI-PATTERN DETECTED on field "${scanResult.field_scanned}". ` +
    `Families: ${families.join(', ')}. Specific hits:\n${sampleLabels}\n\n` +
    `Rewrite the opener as a CONCRETE SCENE — a named person, a specific moment, a sensory detail. ` +
    `NOT a definition. NOT a textbook framing. NOT teacher-talking-about-teaching. ` +
    `Same JSON shape; same schema; only the opener field changes.`;
}

module.exports = {
  PATTERN_BANK,
  OPENER_SCAN_CHARS,
  scanOpener,
  scanLessonBody,
  buildRegenFeedback,
};
