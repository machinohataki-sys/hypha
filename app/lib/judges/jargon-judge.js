'use strict';
// HYPHA · W1.2 Micro-Judge 3/3 · Jargon Detector
// ----------------------------------------------------------------------------
// 关注: lesson body 对 audience_level 是否 jargon-overload —
//   - constitution FORBIDDEN 黑话 (AI/LLM/embedding/model/prompt/agent/RAG/
//     vector/fine-tune) 是 hard-fail (任何 audience).
//   - 领域术语对 audience_level 是否超载: 零基础 5% / 中级 10% / 进阶 15%
//     jargon-density 阈值.
//   - 出现的术语是否 unexplained (lesson 没在邻近段落给出 USE / 应用 / 定义).
//
// 工作流:
//   Stage 1 (algorithmic, sync) — scan hypha-constitution.js FORBIDDEN list +
//       compute jargon_density. EN word-boundary regex, case-insensitive.
//   Stage 2 (T4_JUDGE, async) — 对 audience_level 给一个语义"过载"评分;
//       同时返回 unexplained_terms (LLM 判定哪些术语出现但没有 nearby USE).
//       本 wave 暂留 mock + intentional-placeholder.
//
// 输出 schema:
//   {
//     score: 0-100,                          // high = audience-friendly, low = overload
//     jargon_density: float,                 // forbidden+domain jargon / total words
//     forbidden_words_found: string[],       // FORBIDDEN list 命中
//     unexplained_terms: string[],           // T4_JUDGE 标的术语 (mock = [])
//   }
//
// 阈值: JARGON_FAIL = 25, JARGON_WARN = 50, PASS ≥ 50.
//
// 与 W1.1 关系: 本 judge 输出被 quality-harness/judges/jargon-control.js
// (dim 2/9) 包装. 既有 jargon-firewall.js 是 v0 monitoring-only scanner
// (无 audience-awareness, 无 LLM); 本 W1.2 judge 加 audience_level 阈值 +
// T4_JUDGE 语义层. 不重叠, 互补.

const JARGON_FAIL = 25;
const JARGON_WARN = 50;
const MOCK_SCORE = 50;

// audience_level → jargon_density ceiling.
const DENSITY_CEILING = {
  '零基础': 0.05,
  '中级':   0.10,
  '进阶':   0.15,
};

// Read FORBIDDEN list from constitution (not mutated here — read-only).
let FORBIDDEN_EN;
try {
  // hypha-constitution.js doesn't export a structured list directly — it bakes
  // the words into the FULL prompt string. We mirror the canonical 9 here as
  // the structural source-of-truth + cross-reference jargon-firewall.js.
  const firewall = require('../jargon-firewall');
  FORBIDDEN_EN = (firewall.BANNED_EN || []).map((w) => String(w).toLowerCase());
} catch (_) {
  FORBIDDEN_EN = ['ai', 'llm', 'embedding', 'model', 'prompt', 'agent', 'rag', 'vector', 'fine-tune'];
}

function _bodyText(lessonBody) {
  if (!lessonBody || typeof lessonBody !== 'object') return '';
  const parts = [
    lessonBody.thesis,
    lessonBody.intro_prose,
    lessonBody.canonical_example && (lessonBody.canonical_example.text || lessonBody.canonical_example.example),
    lessonBody.mechanism_explanation,
    lessonBody.closing_prose,
    lessonBody.exit_proof && (lessonBody.exit_proof.prompt || lessonBody.exit_proof.text),
    Array.isArray(lessonBody.jargon_list) ? lessonBody.jargon_list.join('\n') : '',
  ];
  return parts.filter((p) => typeof p === 'string').join('\n');
}

function _wordCount(text) {
  // CJK char split + EN word — matches goal-drift-detector / anti-generic.
  const spaced = String(text).replace(/([一-鿿㐀-䶿])/g, ' $1 ');
  const tokens = spaced.split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
  return tokens.length;
}

function _escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _scanForbiddenEN(text) {
  const hits = [];
  const seen = new Set();
  const low = text.toLowerCase();
  for (const word of FORBIDDEN_EN) {
    // Word-boundary regex; hyphenated 'fine-tune' has no \b on '-' so we use
    // a lookaround pair forcing non-word neighbours.
    const re = new RegExp(`(^|[^a-z0-9])(${_escapeRe(word)})(?=$|[^a-z0-9])`, 'gi');
    if (re.test(low)) {
      if (!seen.has(word)) {
        hits.push(word);
        seen.add(word);
      }
    }
  }
  return hits;
}

/**
 * Grade jargon load for a target audience.
 * @param {object} args
 * @param {object} args.lessonBody
 * @param {'零基础'|'中级'|'进阶'} [args.audience_level='中级']
 * @returns {Promise<{
 *   score: number,
 *   jargon_density: number,
 *   forbidden_words_found: string[],
 *   unexplained_terms: string[],
 * }>}
 */
async function gradeJargon({ lessonBody, audience_level } = {}) {
  const text = _bodyText(lessonBody);
  const audience = audience_level && DENSITY_CEILING[audience_level] != null ? audience_level : '中级';
  const ceiling = DENSITY_CEILING[audience];

  // Stage 1 — FORBIDDEN scan + density.
  const forbidden = _scanForbiddenEN(text);
  const totalWords = Math.max(1, _wordCount(text));
  // density = unique forbidden hits / total words. For domain-term jargon
  // (un-forbidden but specialist), T4_JUDGE handles in stage 2; we count
  // forbidden as a hard subset.
  const jargon_density = +(forbidden.length / totalWords).toFixed(4);

  // Stage 2 — T4_JUDGE "是否对 audience 黑话过多" + unexplained_terms.
  // intentional-placeholder: W1.2 ship = scaffold per task spec. Real prompt
  // requires audience-tagged calibration corpus (W1.4 wave).
  // TODO real T4_JUDGE prompt — compose:
  //   system = HYPHA SHORT constitution
  //   user   = `audience_level: ${audience}\nlesson body:\n${text}\n\n` +
  //            `Score 0-100 how audience-friendly this reads (零基础 strict, ` +
  //            `进阶 loose). List unexplained_terms (jargon used without ` +
  //            `nearby USE / 应用 / 定义). Return JSON {score, unexplained_terms[]}.`
  // executeChat('T4_JUDGE', { messages, json: true, temperature: 0 })
  let semanticScore = MOCK_SCORE;
  const unexplained_terms = []; // mock — real judge fills via Stage 2.

  // Composite: each FORBIDDEN hit -10, density-over-ceiling penalty linear.
  let score = semanticScore;
  score -= forbidden.length * 10;
  if (jargon_density > ceiling) {
    const overshoot = (jargon_density - ceiling) / ceiling;
    score -= Math.min(40, Math.round(overshoot * 30));
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    jargon_density,
    forbidden_words_found: forbidden,
    unexplained_terms,
  };
}

module.exports = {
  gradeJargon,
  JARGON_FAIL,
  JARGON_WARN,
  DENSITY_CEILING,
};
