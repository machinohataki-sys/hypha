'use strict';
// HYPHA · Bias Correction Detector (v0.5.3 anti-slop, 2026-05-19)
//
// Runtime complement to constitution L58 BIAS CORRECTION rule (v0.5.3 strengthened).
// Constitution requires:
//   - 信号类 (consensus/empirical/theoretical/contested/fringe) — REQUIRED
//   - 出处 (citation) — REQUIRED when invoked
//   - 反方 (named opposing school + 1-sentence position) — REQUIRED when
//     信号类 ∈ {contested, fringe, theoretical}
//
// This detector catches the failure mode: lesson body presents a primary
// framework as if settled when scholarship is actually split. Cheap regex pass,
// no LLM call. Returns per-violation records + a summary the anti-slop harness
// can compose into the verdict + Trust Panel surface.
//
// Strategy:
//   (1) Find "primary framework" markers in body text — named scholar + year +
//       assertion verb. Patterns:
//         - "X (YEAR) claims/holds/posits/argues..."  EN
//         - "Y 在《作品》(YEAR) 提出/主张/认为..."     CN
//         - "Z (school NAME, YEAR)..."                  hybrid
//   (2) For each primary, count DISTINCT counter sources within 400-char
//       window after the primary. Counter source = named school / -ist / -ian
//       / 学派 / 主义 / 学说 OR a counter-marker phrase.
//   (3) Categorize:
//         0 counter   → missing_counter_for (severity high under HUMANITIES)
//         1 counter   → weak_counter_for (severity mid — partial bias)
//         ≥2 counter  → strong, not flagged
//   (4) HUMANITIES = strict per-primary; other archetypes = lesson-wide OK.
//
// Caller integration: app/lib/anti-slop/prosecute-judge-rewrite.js will read
// summary.missing_counter_view_count + include in pjr signals object (v0.5).
// Standalone for now — exposed via direct require in tests + future harness.

// Primary framework patterns. Capture group 1 = named scholar handle.
// English: "Harrison (1912) claims X" / "Freud holds..."
// Chinese: "弗洛伊德 (1900)" or "Harrison 在《Themis》(1912)"
const PRIMARY_PATTERNS = [
  // EN: "<Capitalized Name> (<year>) <claim verb>"
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*[\(（]\s*(\d{4})\s*[\)）]\s*(?:[:,.\s]*(?:claims?|holds?|posits?|argues?|maintains?|asserts?|propose[sd]?|theoriz(?:es|ed)|advance[sd]?))/gi,
  // EN: "<Name>'s <theory|claim|thesis|school>"
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})['']s\s+(?:theory|claim|thesis|school|doctrine|hypothesis|framework|principle|axiom)\b/gi,
  // CN: "<人名> 在《作品》(<year>) 提出/主张/认为"
  /([一-龥]{2,4})\s*在\s*[《【]?[一-龥A-Za-z]+[》】]?\s*[\(（]\s*(\d{4})\s*[\)）]\s*[一-龥]*?(?:提出|主张|认为|断言|宣称|论证|主张|阐述)/g,
  // CN: "<人名> 的 <theory>"
  /([一-龥]{2,4})\s*的\s*[一-龥]{2,6}(?:理论|学说|主张|框架|学派|论点|假说|原理)/g,
];

// Counter-view markers anywhere in lesson body. Presence ≥ 1 = OK.
const COUNTER_PATTERNS = [
  /反方[\s::]*[一-龥A-Za-z]/,
  /counter[\-\s]?view/i,
  /opposing\s+(view|school|position)/i,
  /信号类\s*[:：]\s*(?:contested|fringe|theoretical|争议|边缘|理论)/i,
  /(?:rival|opposing|contrary)\s+(?:school|view|thesis|interpretation)/i,
  /(?:dissent|challenged?\s+by|disputed\s+by|critiqued?\s+by)\b/i,
  /[一-龥A-Za-z]+\s*(?:批评|反对|质疑|不同意|挑战)\s*[一-龥A-Za-z]+\s*(?:的\s*[一-龥]+)?/,
];

// Counter-source patterns (v0.5.3). Match a NAMED counter source — a school /
// -ist / -ian label EN, or 学派 / 主义 / 学说 / 派别 / 学派 in CN. Distinct
// matches (deduped case-insensitive) feed the single-vs-multi judgement.
const COUNTER_SOURCE_PATTERNS = [
  /\b([A-Z][a-zA-Z]+(?:ian|ist|ists|ians))\b/g,
  /\b([A-Z][a-zA-Z]+(?:ism|school))\b/g,
  /([一-龥]{1,6}(?:学派|主义|学说|派别|学者|流派))/g,
];

// Counter-marker prefixes — when followed by a capitalized name, the name
// counts as a named counter source even without -ist / -ian / 学派 suffix.
// e.g. "反方: Burkert (1979)" or "challenged by Frazer" → Burkert / Frazer.
const COUNTER_NAMED_SCHOLAR_PATTERNS = [
  /反方[\s:：,，]\s*([A-Z][a-zA-Z]+)/g,
  /(?:challenged|disputed|critiqued|opposed|rejected)\s+by\s+([A-Z][a-zA-Z]+)/gi,
  /(?:counter[\-\s]?view|opposing\s+(?:view|school|position|scholar)|rival\s+(?:view|school|scholar))[:：,，\s]+\s*([A-Z][a-zA-Z]+)/gi,
  /反方[\s:：,，]\s*([一-龥]{2,4})/g,
];

/**
 * Scan lesson body text for primary-framework claims missing counter-view.
 *
 * v0.5.3 additions (backward-compatible, fields ADDED never replaced):
 *   - weak_counter_for: primaries with EXACTLY 1 distinct counter source (still
 *     partial bias; severity 'mid')
 *   - source_count_summary: per-primary { counter_count, sources[] } record
 *
 * @param {string} bodyText  full lesson body markdown / JSON-stringified body
 * @param {object} [opts]
 * @param {string} [opts.archetype]  HUMANITIES gets stricter check (every primary needs counter); other archetypes only fire when ≥2 primaries lack counter
 * @returns {{
 *   primaries_found: number,
 *   counters_found: number,
 *   missing_counter_for: Array<{ scholar: string, year: string|null, snippet: string, line: number }>,
 *   weak_counter_for: Array<{ scholar: string, year: string|null, snippet: string, line: number, sources: string[] }>,
 *   source_count_summary: Object.<string, { counter_count: number, sources: string[] }>,
 *   summary: { score: number, severity: 'none'|'low'|'mid'|'high', should_flag: boolean, archetype: string }
 * }}
 */
// Counter context markers — any of these in the window indicates the text is
// engaging in a debate. Without one of these, a stray "X-ist" / "X 学派" is
// likely the SAME framework as the primary (e.g. "Cambridge Ritualist school"
// next to a Harrison primary), not a counter — so don't count it as a source.
const COUNTER_CONTEXT_MARKERS = [
  /反方/, /counter[\-\s]?view/i, /opposing\s+(view|school|position|scholar)/i,
  /rival\s+(?:view|school|scholar|thesis|interpretation)/i,
  /(?:dissent|challenged?\s+by|disputed\s+by|critiqued?\s+by|rejects?|refutes?|denies)\b/i,
  /批评者|反对者|质疑|不同意|挑战|否定/,
  /信号类\s*[:：]\s*(?:contested|fringe|theoretical|争议|边缘|理论)/i,
  /另有|第二派|第三派别|相反|反之/,
];

function _extractCounterSources(window) {
  const sources = new Set();
  const hasCounterContext = COUNTER_CONTEXT_MARKERS.some(re => re.test(window));

  const collect = (patterns) => {
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(window)) !== null) {
        const raw = (m[1] || '').trim();
        if (!raw) continue;
        const key = /[A-Za-z]/.test(raw) ? raw.toLowerCase() : raw;
        sources.add(key);
        if (re.lastIndex === m.index) re.lastIndex++;
      }
    }
  };

  // Only count generic -ist / -ian / 学派 mentions as counter sources when
  // the body actually frames a debate. Otherwise the match is likely the same
  // school as the primary.
  if (hasCounterContext) {
    collect(COUNTER_SOURCE_PATTERNS);
  }
  // Named scholars after explicit counter markers always count.
  collect(COUNTER_NAMED_SCHOLAR_PATTERNS);

  // Signal-class declaration (信号类: contested/fringe/theoretical) is a
  // distinct counter-evidence signal from a named scholar — counts as its own
  // source per v0.5.3 (epistemic stance + scholar = 2 sources).
  if (/信号类\s*[:：]\s*(?:contested|fringe|theoretical|争议|边缘|理论)/i.test(window)) {
    sources.add('__signal_class_marker__');
  }

  // Generic counter-marker phrase (反方 / counter-view / opposing / rival /
  // dissent / 批评/反对) registers as ONE additional source only when no
  // named source was found — covers the bare "反方: ..." case without a name.
  if (sources.size === 0) {
    for (const re of COUNTER_PATTERNS) {
      if (re.test(window)) { sources.add('__generic_counter__'); break; }
    }
  }
  return Array.from(sources);
}

function detectBiasViolations(bodyText, opts = {}) {
  if (typeof bodyText !== 'string' || bodyText.length === 0) {
    return _emptyResult();
  }
  const archetype = (opts.archetype || '').toUpperCase();

  // Find primaries
  const primaries = [];
  for (const re of PRIMARY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(bodyText)) !== null) {
      const scholar = (m[1] || '').trim();
      const year = m[2] ? String(m[2]) : null;
      if (!scholar || scholar.length < 2) continue;
      // De-dup by scholar+year tuple
      const key = `${scholar}__${year || ''}`;
      if (primaries.find(p => p.key === key)) continue;
      // Compute approximate line number (1-indexed)
      const upToMatch = bodyText.slice(0, m.index);
      const line = upToMatch.split('\n').length;
      // Snippet ±60 chars
      const startSnip = Math.max(0, m.index - 30);
      const endSnip = Math.min(bodyText.length, m.index + m[0].length + 60);
      const snippet = bodyText.slice(startSnip, endSnip).replace(/\s+/g, ' ').trim();
      primaries.push({ key, scholar, year, snippet, line, matchEnd: m.index + m[0].length });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }

  // Find counter-view markers (lesson-wide presence)
  let counterCount = 0;
  for (const re of COUNTER_PATTERNS) {
    if (re.test(bodyText)) counterCount++;
  }

  // Per primary, count distinct counter sources within 400-char window AFTER
  // the primary (per v0.5.3 spec). 0 = missing, 1 = weak, ≥2 = strong.
  // HUMANITIES applies per-primary; other archetypes also accept a single
  // lesson-wide counter as a softener.
  const missing_counter_for = [];
  const weak_counter_for = [];
  const source_count_summary = {};
  for (const p of primaries) {
    const winStart = Math.max(0, p.matchEnd - 400);
    const winEnd = Math.min(bodyText.length, p.matchEnd + 400);
    const window = bodyText.slice(winStart, winEnd);
    const sources = _extractCounterSources(window);
    const sourceCount = sources.length;
    const excerptKey = (p.snippet || `${p.scholar}__${p.year || ''}`).slice(0, 80);
    source_count_summary[excerptKey] = { counter_count: sourceCount, sources };

    const rec = {
      scholar: p.scholar,
      year: p.year,
      snippet: p.snippet,
      line: p.line,
      sources,
      archetype_strict: archetype === 'HUMANITIES',
    };

    if (sourceCount === 0) {
      // HUMANITIES: every primary needs its own counter. Other archetypes
      // accept a lesson-wide counter as a sufficient softener.
      if (archetype === 'HUMANITIES' || counterCount === 0) {
        missing_counter_for.push(rec);
      }
    } else if (sourceCount === 1) {
      // Weak-counter only flags under HUMANITIES — other archetypes treat a
      // single counter as good-enough (matches v0.5.2 less-strict contract).
      if (archetype === 'HUMANITIES') {
        weak_counter_for.push(rec);
      }
    }
    // sourceCount ≥ 2 → strong, no flag.
  }

  // Severity. should_flag now triggered by missing OR weak counters. Backward-
  // compatible: callers that only read missing_counter_for see the same shape
  // when no weak entries exist.
  const missCount = missing_counter_for.length;
  const weakCount = weak_counter_for.length;
  let severity, should_flag;
  if (missCount === 0 && weakCount === 0) {
    severity = 'none';
    should_flag = false;
  } else if (missCount === 0 && weakCount > 0) {
    // Weak-only — partial bias, mid severity per v0.5.3.
    severity = 'mid';
    should_flag = true;
  } else if (missCount === 1 && archetype !== 'HUMANITIES') {
    severity = 'low';
    should_flag = false;
  } else if (missCount <= 2) {
    severity = 'mid';
    should_flag = true;
  } else {
    severity = 'high';
    should_flag = true;
  }

  const flaggedTotal = missCount + weakCount;
  return {
    primaries_found: primaries.length,
    counters_found: counterCount,
    missing_counter_for,
    weak_counter_for,
    source_count_summary,
    summary: {
      score: flaggedTotal === 0 ? 0 : Math.min(1, flaggedTotal / Math.max(1, primaries.length)),
      severity,
      should_flag,
      archetype: archetype || 'UNKNOWN',
    },
  };
}

function _emptyResult() {
  return {
    primaries_found: 0,
    counters_found: 0,
    missing_counter_for: [],
    weak_counter_for: [],
    source_count_summary: {},
    summary: { score: 0, severity: 'none', should_flag: false, archetype: 'UNKNOWN' },
  };
}

module.exports = {
  detectBiasViolations,
  PRIMARY_PATTERNS,
  COUNTER_PATTERNS,
  COUNTER_SOURCE_PATTERNS,
};
