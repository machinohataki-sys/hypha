'use strict';
// HYPHA · Persona classifier (S86 SimPersona MVP, v1.0)
//
// Rule-based archetype classifier for the cohort cold-start kit. Maps
// onboarding answers → { archetype, confidence, why }. Pure function — !
// LLM, ! vector embeddings (defer to v1.1 with real events.jsonl signal).
//
// SimPersona paper (arXiv 2605.14205) ships a VQ-VAE over clickstreams. We
// have no clickstreams Day-1 — the whole reason for the cold-start kit. So
// this MVP uses keyword + threshold scoring against archetype lexicons,
// returning a soft probability across the 4 archetypes (in `breakdown`)
// alongside the top pick. v1.1 swaps lexicons for a learned embedding once
// events.jsonl has enough samples (target: 500 users / 5k trajectories).
//
// Surface contract:
//   classifyFromOnboarding(answers) → { archetype, confidence, why, breakdown }
//   classifyFromText(freeText)      → same shape, for when only narrative is given
//
// Tie-break rule: when two archetypes within 0.1 score, prefer:
//   engineer-senior > researcher > engineer-mid > pm
// Rationale: senior + researcher are smaller cohorts; misclassifying them as
// mid / pm is the more damaging error (under-served depth).

const { ARCHETYPES, isKnownArchetype } = require('./preping-priors.js');

// ---------------------------------------------------------------------------
// Lexicons — hand-curated. Each entry: { match: regex|string, weight: number }
// Weights tuned so a clear-cut answer scores ~0.7-0.9, ambiguous ~0.4-0.5.
// ---------------------------------------------------------------------------
const LEX = Object.freeze({
  'engineer-mid': Object.freeze([
    { match: /\bship(ping|ped)?\b/i, w: 2 },
    { match: /\bdebug(ging)?\b/i, w: 2 },
    { match: /\bfeature\b/i, w: 1.5 },
    { match: /\bsprint\b/i, w: 2 },
    { match: /\bjira\b/i, w: 1.5 },
    { match: /\bIC\b/, w: 2 },
    { match: /\bindividual\s+contributor\b/i, w: 3 },
    { match: /\bjunior\b/i, w: 1 },
    { match: /\bmid[-\s]?level\b/i, w: 3 },
    { match: /\bse[12]?\b/i, w: 2 },
    { match: /\bweekend\s+side[-\s]?project\b/i, w: 2 },
    { match: '上线', w: 2 },
    { match: '日常开发', w: 2 },
    { match: '工程师', w: 1.5 },
    { match: '业务代码', w: 2 },
    { match: '产品需求', w: 1.5 },
    { match: '中级', w: 2 },
    { match: '后端', w: 1 },
    { match: '前端', w: 1 },
    { match: '全栈', w: 1.5 },
    { match: /\b(react|vue|express|fastify|nestjs|spring|django|rails)\b/i, w: 1 },
  ]),
  'engineer-senior': Object.freeze([
    { match: /\bstaff\s+(engineer|eng)\b/i, w: 4 },
    { match: /\bprincipal\b/i, w: 4 },
    { match: /\barchitect\b/i, w: 3 },
    { match: /\btech\s+lead\b/i, w: 3 },
    { match: /\bmentor(ing|s)?\b/i, w: 2 },
    { match: /\bfounder[-\s]?engineer\b/i, w: 4 },
    { match: /\bCTO\b/, w: 3 },
    { match: /\bdistributed\s+systems\b/i, w: 2 },
    { match: /\bsystem\s+design\b/i, w: 1.5 },
    { match: /\bdesign\s+review\b/i, w: 2 },
    { match: /\b10\+?\s*(years?|yr)\b/i, w: 2 },
    { match: /\b\d{2}\s*(years?|yr)\b/i, w: 1.5 },
    { match: '架构师', w: 4 },
    { match: '资深', w: 3 },
    { match: '高级工程师', w: 3 },
    { match: 'staff', w: 2.5 },
    { match: 'principal', w: 3 },
    { match: '技术 leader', w: 2.5 },
    { match: '带团队', w: 2.5 },
    { match: '指导新人', w: 2 },
    { match: '系统设计', w: 1.5 },
    { match: /\b(raft|paxos|consensus|sharding|kubernetes\s+internals)\b/i, w: 1.5 },
  ]),
  'pm': Object.freeze([
    { match: /\bproduct\s+manager\b/i, w: 4 },
    { match: /\bPM\b/, w: 3 },
    { match: /\bPRD\b/, w: 3 },
    { match: /\bproduct\s+owner\b/i, w: 3 },
    { match: /\bAPM\b/, w: 3 },
    { match: /\bGPM\b/, w: 3 },
    { match: /\broadmap\b/i, w: 2 },
    { match: /\bstakeholder\b/i, w: 2 },
    { match: /\buser\s+research\b/i, w: 2 },
    { match: /\bdesign\s+sprint\b/i, w: 1.5 },
    { match: /\bA\/B\s+test/i, w: 1.5 },
    { match: '产品经理', w: 4 },
    { match: '产品负责人', w: 3.5 },
    { match: '产品 owner', w: 3 },
    { match: '业务方', w: 2 },
    { match: '需求文档', w: 2.5 },
    { match: '需求评审', w: 2 },
    { match: '用户调研', w: 2 },
    { match: '产品规划', w: 2.5 },
    { match: '增长', w: 1.5 },
    { match: '商业化', w: 2 },
    { match: '产品策略', w: 2.5 },
  ]),
  'researcher': Object.freeze([
    { match: /\bPhD\b/, w: 4 },
    { match: /\bDoctorate\b/i, w: 3 },
    { match: /\bpostdoc\b/i, w: 4 },
    { match: /\bresearch\s+(engineer|scientist|fellow)\b/i, w: 4 },
    { match: /\bresearcher\b/i, w: 3 },
    { match: /\bprofessor\b/i, w: 3 },
    { match: /\bgrad(uate)?\s+student\b/i, w: 3 },
    { match: /\bacademic\b/i, w: 2 },
    { match: /\b(NeurIPS|ICML|ICLR|CVPR|ACL|EMNLP|SIGGRAPH|NSDI|SOSP|OSDI)\b/, w: 3 },
    { match: /\bpaper(s)?\b/i, w: 1.5 },
    { match: /\barXiv\b/i, w: 2 },
    { match: /\bablation\b/i, w: 2 },
    { match: /\bSOTA\b/, w: 1.5 },
    { match: /\breproduc(e|ibility)\b/i, w: 2 },
    { match: '博士', w: 4 },
    { match: '研究员', w: 4 },
    { match: '科研', w: 3 },
    { match: '论文', w: 1.5 },
    { match: '复现', w: 2 },
    { match: '消融', w: 2 },
    { match: '导师', w: 2 },
    { match: '实验室', w: 2 },
    { match: '会议投稿', w: 2.5 },
    { match: '顶会', w: 2 },
  ]),
});

// Anti-signal lexicons — penalize archetypes when these terms dominate.
// E.g. "完全 ! 懂代码" should kill engineer-* even if 产品经理 also missing.
const ANTI = Object.freeze({
  'engineer-mid':    Object.freeze([
    { match: /\bnever\s+coded\b/i, w: 3 },
    { match: '不会写代码', w: 3 },
    { match: '完全不懂编程', w: 3 },
  ]),
  'engineer-senior': Object.freeze([
    { match: /\b(junior|fresh\s+grad|intern)\b/i, w: 2 },
    { match: '新人', w: 2 },
    { match: '应届', w: 2 },
  ]),
  'pm': Object.freeze([
    { match: /\bI\s+(write|code)\b/i, w: 1 },
    { match: '我写代码', w: 1 },
  ]),
  'researcher': Object.freeze([
    { match: /\bship(ped|ping)\s+(production|prod)\b/i, w: 1.5 },
    { match: '上线', w: 1 },
  ]),
});

const TIE_BREAK_ORDER = Object.freeze(['engineer-senior', 'researcher', 'engineer-mid', 'pm']);

function _matchScore(text, lex) {
  let score = 0;
  for (const entry of lex) {
    if (entry.match instanceof RegExp) {
      const m = text.match(entry.match);
      if (m) score += entry.w;
    } else if (typeof entry.match === 'string') {
      if (text.includes(entry.match)) score += entry.w;
    }
  }
  return score;
}

function _normalize(answers) {
  if (!answers || typeof answers !== 'object') return '';
  const parts = [];
  if (typeof answers === 'string') return String(answers);
  // Common known fields — flatten in stable order so scoring is deterministic.
  const keys = ['role', 'title', 'current_role', 'about', 'bio', 'experience_years',
                'current_focus', 'work_style', 'background', 'north_star_goal',
                'first_goal_seed', 'free_text', 'description', 'context'];
  for (const k of keys) {
    if (answers[k] != null) parts.push(String(answers[k]));
  }
  // Unknown extras — append values.
  for (const k of Object.keys(answers)) {
    if (keys.indexOf(k) === -1 && answers[k] != null) {
      const v = answers[k];
      if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
    }
  }
  return parts.join(' \n ');
}

function _classify(text) {
  const breakdown = {};
  for (const arc of ARCHETYPES) {
    const pos = _matchScore(text, LEX[arc]);
    const neg = _matchScore(text, ANTI[arc] || []);
    breakdown[arc] = Math.max(0, pos - neg);
  }
  // Softmax-ish normalization → confidence in [0, 1].
  const total = ARCHETYPES.reduce((s, a) => s + breakdown[a], 0);
  const normalized = {};
  for (const arc of ARCHETYPES) {
    normalized[arc] = total > 0 ? breakdown[arc] / total : 0;
  }
  // Pick top — break ties by TIE_BREAK_ORDER.
  let top = null;
  let topScore = -1;
  for (const arc of TIE_BREAK_ORDER) {
    const s = normalized[arc];
    if (s > topScore + 0.10) {
      top = arc;
      topScore = s;
    } else if (s > topScore - 0.10 && top === null) {
      top = arc;
      topScore = s;
    }
  }
  if (top === null) top = TIE_BREAK_ORDER[0];
  return { archetype: top, confidence: normalized[top], breakdown: normalized, raw: breakdown };
}

function _explain(top, breakdown, raw) {
  const confPct = Math.round((breakdown[top] || 0) * 100);
  const runnerUp = ARCHETYPES
    .filter(a => a !== top)
    .sort((a, b) => breakdown[b] - breakdown[a])[0];
  const gap = Math.round(((breakdown[top] || 0) - (breakdown[runnerUp] || 0)) * 100);
  if (raw[top] === 0) {
    return `! signal — fallback to ${top}. 用户应在 settings 调整。`;
  }
  if (gap < 10) {
    return `${top} (${confPct}%) over ${runnerUp} (差 ${gap}%) — 信号弱,建议 user confirm。`;
  }
  return `${top} (${confPct}%) — 比第二档 ${runnerUp} 高 ${gap}%。`;
}

/**
 * classifyFromOnboarding — Day-1 archetype pick from structured answers.
 * @param {object} answers — flexible shape; expects role/experience_years/current_focus/work_style optionally
 * @returns {{ archetype: string, confidence: number, why: string, breakdown: object }}
 */
function classifyFromOnboarding(answers) {
  const text = _normalize(answers);
  if (!text || text.trim().length === 0) {
    return {
      archetype: 'engineer-mid',
      confidence: 0,
      why: '空 answers — 默认 engineer-mid (最大 cohort)。',
      breakdown: { 'engineer-mid': 0.25, 'engineer-senior': 0.25, 'pm': 0.25, 'researcher': 0.25 },
    };
  }
  const { archetype, breakdown, raw } = _classify(text);
  return {
    archetype,
    confidence: breakdown[archetype] || 0,
    why: _explain(archetype, breakdown, raw),
    breakdown,
  };
}

function classifyFromText(freeText) {
  return classifyFromOnboarding({ free_text: String(freeText || '') });
}

module.exports = {
  classifyFromOnboarding,
  classifyFromText,
  ARCHETYPES,
  isKnownArchetype,
  // internal — exposed for smoke
  _classify,
  _normalize,
};
