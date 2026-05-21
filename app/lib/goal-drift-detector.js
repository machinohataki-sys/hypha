'use strict';

/**
 * HYPHA · Goal Drift Detector basics — v0.2
 *
 * Static rule-based drift detection between Goal Contract and Lesson output.
 * v0.2 basics: 4 axis algorithmic scoring, NO LLM call.
 * v0.3+ will add LLM-judged semantic drift.
 *
 * 4 axes (each 0-100, high = drift):
 *   1. vocab     — fraction of lesson words NOT in goal vocabulary
 *   2. alignment — Jaccard distance between lesson.objective tokens vs (north_star_goal + main_creation) tokens
 *   3. forbidden — count of goalContract.forbidden_drifts items appearing in lesson, scaled
 *   4. jargon_load — % of jargon-firewall BANNED_EN words in lesson
 *
 * Total drift_score = round(0.3·vocab + 0.3·alignment + 0.3·forbidden + 0.1·jargon_load)
 *
 * Returns:
 *   { drift_score, axes: {vocab, alignment, forbidden, jargon_load}, violations: [{axis, text, position}] }
 *
 * Tokenization: splits on /[\s\p{P}\p{S}]+/u after CJK-spacing pass so each
 * CJK char becomes its own token. EN words remain whole. All lowercased.
 */

let BANNED_EN_FALLBACK = ['llm', 'ai', 'embedding', 'agent', 'prompt', 'rag', 'vector', 'finetune', 'model', 'token'];
let BANNED_EN;
try {
  const jargonFirewall = require('./jargon-firewall');
  BANNED_EN = (jargonFirewall.BANNED_EN || BANNED_EN_FALLBACK).map(w => w.toLowerCase());
} catch (_) {
  BANNED_EN = BANNED_EN_FALLBACK;
}

function spaceCJK(s) {
  return String(s || '').replace(/([一-鿿㐀-䶿])/g, ' $1 ');
}

function tokenize(s) {
  return spaceCJK(s)
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter(Boolean);
}

function jaccardDistance(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  if (union === 0) return 0;
  return 1 - inter / union;
}

function countSubstrings(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

function detectDrift(goalContract, lessonOutput) {
  const goal = goalContract || {};
  const lessonText = JSON.stringify(lessonOutput || {});
  const lessonTokens = tokenize(lessonText);
  const lessonSet = new Set(lessonTokens);

  const violations = [];

  // axis 1: vocab drift
  const goalVocabText = [
    goal.north_star_goal || '',
    goal.main_creation || '',
    Array.isArray(goal.core_competencies) ? goal.core_competencies.join(' ') : '',
  ].join(' ');
  const goalVocabSet = new Set(tokenize(goalVocabText));
  let overlap = 0;
  for (const t of lessonTokens) if (goalVocabSet.has(t)) overlap++;
  const vocab = lessonTokens.length === 0
    ? 0
    : Math.round((1 - overlap / lessonTokens.length) * 100);

  // axis 2: alignment via Jaccard distance
  const objectiveTokens = new Set(tokenize(lessonOutput && lessonOutput.objective || ''));
  const goalCoreTokens = new Set(tokenize(`${goal.north_star_goal || ''} ${goal.main_creation || ''}`));
  const alignment = Math.round(jaccardDistance(objectiveTokens, goalCoreTokens) * 100);

  // axis 3: forbidden hits (substring match, ZH-friendly)
  const forbidden_drifts = Array.isArray(goal.forbidden_drifts) ? goal.forbidden_drifts : [];
  let forbiddenHits = 0;
  for (const f of forbidden_drifts) {
    if (!f) continue;
    const hits = countSubstrings(lessonText, f);
    forbiddenHits += hits;
    if (hits > 0) {
      let pos = 0;
      for (let i = 0; i < hits; i++) {
        const idx = lessonText.indexOf(f, pos);
        if (idx === -1) break;
        violations.push({ axis: 'forbidden', text: f, position: idx });
        pos = idx + f.length;
      }
    }
  }
  const forbidden = Math.min(100, forbiddenHits * 25);

  // axis 4: jargon load
  const lessonLower = lessonText.toLowerCase();
  let jargonHits = 0;
  for (const word of BANNED_EN) {
    const w = word.toLowerCase();
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    let m;
    while ((m = re.exec(lessonLower)) !== null) {
      jargonHits++;
      violations.push({ axis: 'jargon_load', text: word, position: m.index });
    }
  }
  const jargon_load = lessonTokens.length === 0
    ? 0
    : Math.min(100, Math.round((jargonHits / lessonTokens.length) * 100));

  const drift_score = Math.round(0.3 * vocab + 0.3 * alignment + 0.3 * forbidden + 0.1 * jargon_load);

  return {
    drift_score,
    axes: { vocab, alignment, forbidden, jargon_load },
    violations,
  };
}

// ── Multi-axis composite drift (v0.12, 2026-05-21) ─────────────────────────
// Existing detectDrift returns single-score drift across 4 algorithmic axes
// (vocab / alignment / forbidden / jargon_load). detectDriftMultiAxis layers
// 3 ORTHOGONAL axes on top — composite captures register + success-test drift
// that vocab+alignment cannot. Returns OLD shape + axes_composite + composite_score.
//
// Three axes (each 0..1, high = drift):
//   1. semantic              — re-use detectDrift().drift_score / 100
//   2. epistemic_register    — HUMANITIES goal vs TECH lesson output (or vice versa) mismatch
//   3. success_criteria_alignment — lesson output references the stated success test / verifiable target
//
// Composite = 0.45·semantic + 0.30·epistemic_register + 0.25·success_criteria

const HUMANITIES_REGISTER_TOKENS = ['文学', '小说', '诗', '散文', '剧', '作家', '故事', '叙事', '隐喻', 'literature', 'narrative', 'poetry', 'novel', 'essay'];
const TECH_REGISTER_TOKENS = ['函数', '算法', '编程', '代码', '架构', '部署', '编译', 'function', 'algorithm', 'compile', 'deploy', 'api', 'sdk', 'http'];
const HUMANITIES_ARCHETYPES = ['HUMANITIES', 'MINDSET'];
const TECH_ARCHETYPES = ['TECH-CONCEPT', 'TECH-PROC', 'LANG-ACQ', 'DECL-MASS'];

function _registerSignature(text) {
  const lower = String(text || '').toLowerCase();
  let hum = 0, tech = 0;
  for (const t of HUMANITIES_REGISTER_TOKENS) {
    if (lower.includes(t.toLowerCase())) hum++;
  }
  for (const t of TECH_REGISTER_TOKENS) {
    if (lower.includes(t.toLowerCase())) tech++;
  }
  return { hum, tech, total: hum + tech };
}

function _registerDrift(goalContract, lessonOutput) {
  const archetype = goalContract && goalContract.archetype;
  const goalText = [goalContract && goalContract.north_star_goal, goalContract && goalContract.main_creation].filter(Boolean).join(' ');
  const lessonText = JSON.stringify(lessonOutput || {});
  const goalSig = _registerSignature(goalText);
  const lessonSig = _registerSignature(lessonText);

  let expected = null;
  if (archetype && HUMANITIES_ARCHETYPES.includes(archetype)) expected = 'hum';
  else if (archetype && TECH_ARCHETYPES.includes(archetype)) expected = 'tech';
  else if (goalSig.total > 0) expected = goalSig.hum >= goalSig.tech ? 'hum' : 'tech';

  if (!expected || lessonSig.total === 0) return 0;
  const wrongShare = expected === 'hum'
    ? lessonSig.tech / lessonSig.total
    : lessonSig.hum / lessonSig.total;
  return Math.max(0, Math.min(1, wrongShare));
}

function _successCriteriaDrift(goalContract, lessonOutput) {
  const goal = goalContract || {};
  const criteria = [
    goal.success_test, goal.success_criteria, goal.verifiable_outcome,
    goal.main_creation, ...(Array.isArray(goal.milestones) ? goal.milestones : []),
  ].filter(t => typeof t === 'string' && t.trim());

  if (criteria.length === 0) return 0;
  const lessonText = JSON.stringify(lessonOutput || {}).toLowerCase();
  const criteriaTokens = new Set();
  for (const c of criteria) for (const tok of tokenize(c)) if (tok.length >= 2) criteriaTokens.add(tok);
  if (criteriaTokens.size === 0) return 0;
  let hit = 0;
  for (const tok of criteriaTokens) if (lessonText.includes(tok)) hit++;
  return Math.max(0, Math.min(1, 1 - hit / criteriaTokens.size));
}

function detectDriftMultiAxis(goalContract, lessonOutput) {
  const base = detectDrift(goalContract, lessonOutput);
  const semantic = Math.max(0, Math.min(1, (base.drift_score || 0) / 100));
  const epistemic_register = _registerDrift(goalContract, lessonOutput);
  const success_criteria_alignment = _successCriteriaDrift(goalContract, lessonOutput);
  const composite_score = 0.45 * semantic + 0.30 * epistemic_register + 0.25 * success_criteria_alignment;
  return {
    ...base,
    axes_composite: {
      semantic: Math.round(semantic * 100) / 100,
      epistemic_register: Math.round(epistemic_register * 100) / 100,
      success_criteria_alignment: Math.round(success_criteria_alignment * 100) / 100,
    },
    composite_score: Math.round(composite_score * 100) / 100,
    composite_verdict: composite_score >= 0.6 ? 'high'
      : composite_score >= 0.35 ? 'moderate'
      : 'low',
  };
}

module.exports = {
  detectDrift,
  detectDriftMultiAxis,
  _registerSignature,
  _registerDrift,
  _successCriteriaDrift,
};
