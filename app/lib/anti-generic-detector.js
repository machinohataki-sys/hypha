'use strict';

/**
 * HYPHA · Anti-Generic-Course Detector v0.2 — algorithmic scorer.
 *
 * Pure regex/substring scan. No LLM call. No async. No IO.
 * v0.3+ will add LLM-judged generic detection on top.
 *
 * Per BLUEPRINT v0.2 §6.4 + §1.1 + §6.2: HYPHA must NOT produce
 * 普通网课式总结 (generic course summaries). Detector flags boilerplate.
 *
 * 7 axes (each 0-100, high = more generic):
 *   1. opener            — 网课开场白 phrases
 *   2. closer            — canned 结尾 phrases
 *   3. scholar_filler    — 无内容学者腔 (众所周知 / 毫无疑问 / 显而易见 ...)
 *   4. transition_overuse — 首先/其次 排比 standalone + 因此/所以 ≥3
 *   5. abstract_verbs    — 提升/优化/赋能 ... without nearby concrete noun
 *   6. vague_examples    — 比如/例如 followed by < 20 chars or another transition
 *   7. concrete_density  — concrete noun count / body length ratio inverted
 *
 * Total generic_score = round(
 *   0.15·opener + 0.15·closer + 0.15·scholar_filler +
 *   0.10·transition_overuse + 0.15·abstract_verbs +
 *   0.10·vague_examples + 0.20·concrete_density
 * )
 *
 * Tokenization: matches goal-drift-detector style (CJK char split + EN word).
 *
 * @typedef {object} LessonBody
 * @property {string} [intro_prose]
 * @property {Array<{step_id?: string, prose: string}>} [path_prose]
 * @property {string} [closing_prose]
 *
 * @typedef {object} GenericReport
 * @property {number} generic_score
 * @property {{opener:number, closer:number, scholar_filler:number, transition_overuse:number, abstract_verbs:number, vague_examples:number, concrete_density:number}} axes
 * @property {Array<{axis:string, text:string, position:number}>} violations
 */

const OPENERS = [
  '今天我们来讲',
  '今天我们要讲',
  '今天我们学习',
  '在本节课中',
  '本节课主要内容',
  '本节课我们',
  '让我们开始学习',
  '让我们一起来',
  '本课程将',
  '本课程主要',
];

const CLOSERS = [
  '总结一下',
  '综上所述',
  '希望大家',
  '接下来我们',
  '请大家记住',
  '相信大家',
  '通过本节课',
  '通过这节课',
];

const SCHOLAR_FILLER = [
  '众所周知',
  '毫无疑问',
  '显而易见',
  '不言而喻',
  '众望所归',
  '不可否认',
  '理所当然',
];

const ABSTRACT_VERBS = [
  '提升',
  '优化',
  '赋能',
  '重塑',
  '革新',
  '打造',
  '深化',
  '强化',
  '夯实',
];

const TRANSITION_LINE_START = /^(?:首先|其次|再次|最后|然后)[，,。\s]/m;
const TRANSITION_CAUSAL = ['因此', '所以', '由此可见', '于是'];

const EXAMPLE_MARKERS = ['比如', '例如', '譬如'];

// Concrete-noun signals (designed to AVOID false positives on abstract CJK prose):
//   (a) digits + unit / quantity (中英文)
//   (b) bare digits (>= 2 digits — version numbers, IDs, counts)
//   (c) EN word / token (consecutive ASCII letters/digits, length >= 3) — proper-ish nouns
//   (d) bracketed / quoted CJK term (引号 / 书名号 / 全角括号) — explicit nominal anchors
//   (e) CJK term followed by an EN ID / number (e.g. SKU=A1024, 工单号 W-20260508-001)
const CONCRETE_PATTERNS = [
  /\d+(?:\.\d+)?\s*(?:%|％|秒|分钟|小时|天|周|月|年|次|个|项|条|行|字|段|步|轮|档|件|台|份|kg|g|mg|km|m|cm|ms|s|h)/gi,
  /\b\d{2,}\b/g,
  /\b[A-Za-z][A-Za-z0-9_-]{2,}\b/g,
  /[「『《（【][^」』》）】\s]{1,16}[」』》）】]/g,
  /[一-鿿㐀-䶿]{2,}\s*[=:：]\s*[A-Za-z0-9][A-Za-z0-9_-]*/g,
];

function spaceCJK(s) {
  return String(s || '').replace(/([一-鿿㐀-䶿])/g, ' $1 ');
}

/**
 * @param {string} s
 * @returns {string[]}
 */
function tokenize(s) {
  return spaceCJK(s)
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter(Boolean);
}

/**
 * Flatten a LessonBody into a single string for scanning.
 * @param {LessonBody} body
 * @returns {string}
 */
function flattenBody(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  if (typeof body.intro_prose === 'string') parts.push(body.intro_prose);
  if (Array.isArray(body.path_prose)) {
    for (const step of body.path_prose) {
      if (step && typeof step.prose === 'string') parts.push(step.prose);
    }
  }
  if (typeof body.closing_prose === 'string') parts.push(body.closing_prose);
  return parts.join('\n');
}

/**
 * Find all positions of a literal substring in text.
 * @param {string} text
 * @param {string} needle
 * @returns {number[]}
 */
function findAll(text, needle) {
  if (!needle) return [];
  const positions = [];
  let from = 0;
  while (true) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + needle.length;
  }
  return positions;
}

/**
 * Count concrete-noun occurrences in text.
 * @param {string} text
 * @returns {number}
 */
function countConcrete(text) {
  let total = 0;
  for (const pattern of CONCRETE_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) total += matches.length;
  }
  return total;
}

/**
 * Test whether a concrete noun lives within `window` chars of `pos` in `text`.
 * @param {string} text
 * @param {number} pos
 * @param {number} window
 * @returns {boolean}
 */
function hasConcreteNear(text, pos, window) {
  const start = Math.max(0, pos - window);
  const end = Math.min(text.length, pos + window);
  const slice = text.slice(start, end);
  for (const pattern of CONCRETE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(slice)) return true;
  }
  return false;
}

/**
 * Detect generic-course boilerplate in a lesson body.
 * @param {LessonBody} lessonBody
 * @returns {GenericReport}
 */
function detectGeneric(lessonBody) {
  const text = flattenBody(lessonBody);
  /** @type {Array<{axis:string, text:string, position:number}>} */
  const violations = [];

  // axis 1: opener
  let openerHits = 0;
  for (const phrase of OPENERS) {
    const positions = findAll(text, phrase);
    openerHits += positions.length;
    for (const p of positions) violations.push({ axis: 'opener', text: phrase, position: p });
  }
  const opener = Math.min(100, openerHits * 25);

  // axis 2: closer
  let closerHits = 0;
  for (const phrase of CLOSERS) {
    const positions = findAll(text, phrase);
    closerHits += positions.length;
    for (const p of positions) violations.push({ axis: 'closer', text: phrase, position: p });
  }
  const closer = Math.min(100, closerHits * 25);

  // axis 3: scholar_filler
  let scholarHits = 0;
  for (const phrase of SCHOLAR_FILLER) {
    const positions = findAll(text, phrase);
    scholarHits += positions.length;
    for (const p of positions) violations.push({ axis: 'scholar_filler', text: phrase, position: p });
  }
  const scholar_filler = Math.min(100, scholarHits * 25);

  // axis 4: transition_overuse
  // (a) 首先/其次/再次 line-start standalone
  let lineStartHits = 0;
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TRANSITION_LINE_START.test(line)) {
      lineStartHits++;
      const m = line.match(TRANSITION_LINE_START);
      if (m) violations.push({ axis: 'transition_overuse', text: m[0].trim(), position: text.indexOf(line) });
    }
  }
  // (b) 因此/所以 ≥ 3 occurrences
  let causalHits = 0;
  for (const phrase of TRANSITION_CAUSAL) {
    const positions = findAll(text, phrase);
    causalHits += positions.length;
  }
  let transition_overuse = 0;
  if (lineStartHits >= 3 || causalHits >= 3) transition_overuse = 100;
  else transition_overuse = Math.min(100, (lineStartHits + causalHits) * 20);

  // axis 5: abstract_verbs without nearby concrete noun (5-char window each side)
  let abstractBareHits = 0;
  for (const verb of ABSTRACT_VERBS) {
    const positions = findAll(text, verb);
    for (const p of positions) {
      if (!hasConcreteNear(text, p, 5)) {
        abstractBareHits++;
        violations.push({ axis: 'abstract_verbs', text: verb, position: p });
      }
    }
  }
  const abstract_verbs = Math.min(100, abstractBareHits * 20);

  // axis 6: vague_examples — 比如/例如 followed by < 20-char noun-phrase or another transition
  let vagueHits = 0;
  for (const marker of EXAMPLE_MARKERS) {
    const positions = findAll(text, marker);
    for (const p of positions) {
      const after = text.slice(p + marker.length, p + marker.length + 30);
      // Cut to first sentence terminator
      const cut = after.split(/[。！？!?\n]/)[0] || '';
      const trimmed = cut.replace(/^[，,：:\s]+/, '');
      const containsTransition = TRANSITION_CAUSAL.some(t => trimmed.includes(t)) ||
        /^(?:首先|其次|再次|最后|然后)/.test(trimmed);
      if (trimmed.length < 20 || containsTransition) {
        vagueHits++;
        violations.push({ axis: 'vague_examples', text: `${marker}${trimmed}`.slice(0, 40), position: p });
      }
    }
  }
  const vague_examples = Math.min(100, vagueHits * 20);

  // axis 7: concrete_density — concrete noun count / body length
  // ratio < 0.02 → 100; ratio > 0.08 → 0; linear in between.
  const bodyLen = text.length;
  const concreteCount = countConcrete(text);
  let concrete_density = 0;
  if (bodyLen === 0) {
    concrete_density = 100;
  } else {
    const ratio = concreteCount / bodyLen;
    if (ratio <= 0.02) concrete_density = 100;
    else if (ratio >= 0.08) concrete_density = 0;
    else {
      // linear interpolation: 0.02 → 100, 0.08 → 0
      concrete_density = Math.round(((0.08 - ratio) / (0.08 - 0.02)) * 100);
    }
  }

  const generic_score = Math.round(
    0.15 * opener +
    0.15 * closer +
    0.15 * scholar_filler +
    0.10 * transition_overuse +
    0.15 * abstract_verbs +
    0.10 * vague_examples +
    0.20 * concrete_density
  );

  return {
    generic_score,
    axes: {
      opener,
      closer,
      scholar_filler,
      transition_overuse,
      abstract_verbs,
      vague_examples,
      concrete_density,
    },
    violations,
  };
}

module.exports = { detectGeneric };
