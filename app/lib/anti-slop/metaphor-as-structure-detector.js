'use strict';
// HYPHA · Metaphor-as-Structure Detector (AMD-MEOW-P7 D.0 anti-metaphor patch, 2026-05-18)
//
// User complaint 2026-05-18: HYPHA 生成 lesson 充满 "一大堆比喻和例子" 而 ! 强迫
// student 经历 cognitive operation. Council verdict (Lung/Leo/Yogo + Muse cross-cut):
// 比喻 = media, ! structure. 单独存在 = entertainment, ! transformation.
// 顶级教师 = engineer recoverable failure; metaphor 只在挂在 forcing function 上时
// 承担教学, ! 单独 deliver.
//
// 此 detector 不调 LLM. 跑 2 pass:
//   (1) 找 metaphor marker (比如/想象/好比/就像/如同/仿佛/像...一样 + analogy/metaphor)
//   (2) 每个 metaphor 上下文 ±200 char 找 forcing function marker:
//       - PRE-QUESTION COMMIT (先猜/先预测/你认为/before reveal)
//       - FORCED-RECALL (不查资料/复述/默写/from memory)
//       - COMMIT-BEFORE-REVEAL (写完发我/之后我给/提交后)
//       - FORCED CONTRAST (A 与 A'/哪不同/对比)
//       - MISCONCEPTION-ELICIT (常见误解/你是不是觉得/defend then attack)
//       - PRODUCTION (重写/改写/artifact)
//
// 集成 v0.4 anti-slop stack: agent.js streamTurn _runAntiSlopPostStreamScan
// 调 detectMetaphorAsStructure(text, {archetype}), 结果进 signals.metaphor + 写
// events.jsonl `anti_slop_metaphor_scan` 行. PJR 在 mid/high severity 时可加 axis.
//
// Archetype-aware: HUMANITIES 文学 register 自然 metaphor 密度高, 阈值放宽
// (0.7x); TECH-PROC 最严 (1.0x); LANG-ACQ 含外语 mock-metaphor 0.8x.

const CONTEXT_WINDOW = 200; // ±chars around each metaphor span

// ---- metaphor markers --------------------------------------------------------
// Each entry = [regex, label]. Lowercased detection; original-cased span preserved.
// 中文 markers 用 (?: ) non-capturing, English markers \b 边界保护.
const METAPHOR_PATTERNS = Object.freeze([
  // Chinese explicit comparison particles
  { re: /比如(?:说)?/gu,        label: 'bi-ru' },
  { re: /例如/gu,                label: 'li-ru' },
  { re: /想象一下/gu,            label: 'imagine' },
  { re: /想象/gu,                label: 'imagine-short' },
  { re: /好比(?:是)?/gu,         label: 'hao-bi' },
  { re: /就像(?:是)?/gu,         label: 'jiu-xiang' },
  { re: /如同/gu,                label: 'ru-tong' },
  { re: /仿佛/gu,                label: 'fang-fu' },
  { re: /犹如/gu,                label: 'you-ru' },
  { re: /好似/gu,                label: 'hao-si' },
  { re: /宛如/gu,                label: 'wan-ru' },
  // "像 X 一样" / "如 X 一般" patterns (X any chars up to 30)
  { re: /像[^\s,，。;；]{1,30}?一样/gu,     label: 'xiang-yi-yang' },
  { re: /如[^\s,，。;；]{1,30}?一般/gu,     label: 'ru-yi-ban' },
  { re: /像是[^\s,，。;；]{1,30}/gu,        label: 'xiang-shi' },
  // English markers
  { re: /\banalogy\b/gi,         label: 'analogy-en' },
  { re: /\bmetaphor\b/gi,        label: 'metaphor-en' },
  { re: /\bfor (?:instance|example)\b/gi, label: 'for-example-en' },
  { re: /\blike a[n]? [a-z]+/gi, label: 'like-a-en' },
  { re: /\bimagine\b/gi,         label: 'imagine-en' },
  { re: /\bthink of (?:it )?as\b/gi, label: 'think-of-as-en' },
]);

// ---- forcing-function markers -----------------------------------------------
const FORCE_PATTERNS = Object.freeze({
  pre_question: [
    /先猜/gu, /先预测/gu, /先想想/gu, /先写(?:一[条句])?/gu, /先回答/gu,
    /你猜/gu, /你认为/gu, /你觉得.{0,8}是什么/gu, /你会怎么/gu,
    /\bpredict\b/gi, /\bguess (?:first|before)/gi, /\bbefore (?:I |we )?reveal/gi,
  ],
  forced_recall: [
    /不查资料/gu, /不看(?:书|笔记|答案)/gu, /复述/gu, /默写/gu, /回忆(?:一下)?/gu,
    /\bfrom memory\b/gi, /\brecall\b/gi, /\bwithout (?:looking|notes)/gi,
  ],
  commit_before_reveal: [
    /写完(?:发我|提交)/gu, /之后(?:我|才)给/gu, /提交后(?:才)?/gu, /写一句.{0,20}发我/gu,
    /我看到.{0,10}才/gu, /承诺/gu,
    /\bsubmit (?:first|before)/gi, /\bcommit (?:first|before)/gi,
  ],
  forced_contrast: [
    /哪不同/gu, /有何差异/gu, /对比一下/gu, /比较两者/gu, /A.{0,5}与.{0,5}A'/gu,
    /\bcontrast\b/gi, /\bvs\.?\b/gi, /\bcompare these/gi,
  ],
  misconception_elicit: [
    /常见(?:的)?误解/gu, /你是不是觉得/gu, /可能会误以为/gu, /典型错误/gu,
    /先defend/gi, /再attack/gi, /反驳自己/gu,
    /\bmisconception\b/gi, /\bdefend then attack/gi,
  ],
  production: [
    /重写(?:一[条句段])/gu, /改写(?:成)?/gu, /自己产(?:出|个)/gu, /产出.{0,5}artifact/gi,
    /写一[条句段].{0,20}发我/gu,
    /\bproduce\b/gi, /\bartifact\b/gi, /\brewrite\b/gi,
  ],
});

// archetype-aware verdict thresholds (force_pair_ratio cutoff for TYPE_A_DISGUISED)
const ARCHETYPE_THRESHOLDS = Object.freeze({
  'TECH-CONCEPT': 0.5,
  'TECH-PROC':    0.5,
  'DECL-MASS':    0.5,
  'HUMANITIES':   0.35, // 文学 register: 比喻自然密度高, 放宽
  'LANG-ACQ':     0.4,
  'MINDSET':      0.45,
});

const MIN_METAPHOR_FOR_VERDICT = 3; // ≤ 2 metaphors → INSUFFICIENT_DATA

/**
 * Find all metaphor spans in text. Dedup by overlapping span starts (within 5 chars).
 * @param {string} text
 * @returns {Array<{start: number, end: number, marker: string, label: string}>}
 */
function findMetaphors(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const found = [];
  const seenStarts = [];
  for (const { re, label } of METAPHOR_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // dedup: skip if within 5 chars of an already-recorded start
      let dup = false;
      for (const s of seenStarts) if (Math.abs(s - start) < 5) { dup = true; break; }
      if (dup) continue;
      seenStarts.push(start);
      found.push({ start, end, marker: m[0], label });
    }
  }
  found.sort((a, b) => a.start - b.start);
  return found;
}

/**
 * Scan the ±CONTEXT_WINDOW around a metaphor for any forcing-function marker.
 * Returns array of force-type labels found (may be empty).
 * @param {string} text
 * @param {{start: number, end: number}} metaphor
 * @returns {Array<string>}
 */
function findSupportingForcers(text, metaphor) {
  const ctxStart = Math.max(0, metaphor.start - CONTEXT_WINDOW);
  const ctxEnd   = Math.min(text.length, metaphor.end + CONTEXT_WINDOW);
  const window = text.slice(ctxStart, ctxEnd);
  const found = new Set();
  for (const [forceType, patterns] of Object.entries(FORCE_PATTERNS)) {
    for (const re of patterns) {
      re.lastIndex = 0;
      if (re.test(window)) { found.add(forceType); break; }
    }
  }
  return Array.from(found);
}

/**
 * Public detect. Returns per-metaphor support records + summary verdict.
 *
 * @param {string} text — lesson body or tutor reply
 * @param {{archetype?: string}} [opts]
 * @returns {{
 *   metaphors: Array<{marker:string, label:string, span:[number,number], context:string, support_forcers:string[], supported:boolean}>,
 *   summary: {
 *     metaphor_count: number,
 *     supported_count: number,
 *     unsupported_count: number,
 *     force_pair_ratio: number,
 *     archetype_threshold: number,
 *     archetype: string,
 *     verdict: 'CLEAN' | 'INSUFFICIENT_DATA' | 'BALANCED' | 'TYPE_A_DISGUISED'
 *   }
 * }}
 */
function detectMetaphorAsStructure(text, opts) {
  const archetype = (opts && typeof opts.archetype === 'string' && opts.archetype.trim())
    ? opts.archetype.trim()
    : 'TECH-CONCEPT';
  const threshold = ARCHETYPE_THRESHOLDS[archetype] || 0.5;

  const spans = findMetaphors(text);
  const metaphors = spans.map(sp => {
    const forcers = findSupportingForcers(text, sp);
    const ctxStart = Math.max(0, sp.start - CONTEXT_WINDOW);
    const ctxEnd   = Math.min((text || '').length, sp.end + CONTEXT_WINDOW);
    return {
      marker: sp.marker,
      label: sp.label,
      span: [sp.start, sp.end],
      context: (text || '').slice(ctxStart, ctxEnd),
      support_forcers: forcers,
      supported: forcers.length > 0,
    };
  });

  const metaphor_count    = metaphors.length;
  const supported_count   = metaphors.filter(m => m.supported).length;
  const unsupported_count = metaphor_count - supported_count;
  const force_pair_ratio  = metaphor_count === 0 ? 1 : supported_count / metaphor_count;

  let verdict;
  if (metaphor_count === 0) verdict = 'CLEAN';
  else if (metaphor_count < MIN_METAPHOR_FOR_VERDICT) verdict = 'INSUFFICIENT_DATA';
  else if (force_pair_ratio < threshold) verdict = 'TYPE_A_DISGUISED';
  else verdict = 'BALANCED';

  return {
    metaphors,
    summary: {
      metaphor_count,
      supported_count,
      unsupported_count,
      force_pair_ratio: Number(force_pair_ratio.toFixed(3)),
      archetype_threshold: threshold,
      archetype,
      verdict,
    },
  };
}

module.exports = {
  detectMetaphorAsStructure,
  _internals: {
    findMetaphors,
    findSupportingForcers,
    METAPHOR_PATTERNS,
    FORCE_PATTERNS,
    ARCHETYPE_THRESHOLDS,
    MIN_METAPHOR_FOR_VERDICT,
    CONTEXT_WINDOW,
  },
};
