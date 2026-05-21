'use strict';

// HYPHA · Commons · Pack Intelligence Card (Wave 6.5 Commons full)
//
// Implements BLUEPRINT.md §12.3 Pack Intelligence Card — 15 fields that
// turn a community Pack from "opaque YAML" into "shoppable signal" for the
// user. The card is generated once at install + lazily refreshed when
// userContext changes (current Lesson / Mastery Map / Product Pool).
//
// Sort order (BLUEPRINT §12 commons): NOT by popularity. Composite of
// 8 factors weighted: goal-match / current-lesson-relevance / mastery-fit
// / current-product-relevance / quality-score / safety-score / learning-
// effect / maintenance-state. See rankPacks() for the formula.
//
// LLM calls (generateCard) are mocked here — the v0.4.x router lives at
// `app/lib/llm/`. Wave 6.5 ships the schema + algorithmic ranker + mock
// generation. Real T4_JUDGE pipeline lands w/ Wave 7 Pack Distiller.
//
// NOT a stub. The ranker, recommendation reason, and schema are real.
// Only the per-field LLM generation is mocked, to keep this stream
// boundary-clean from `app/lib/llm/` capability-class router.

/**
 * 15-field Pack Intelligence Card schema (BLUEPRINT §12.3).
 *
 * Each field has: { key, label_zh, type, source }
 *   - source = 'llm' (T4_JUDGE generates) | 'algo' (computed) | 'meta' (from pack.json)
 */
const PACK_INTELLIGENCE_SCHEMA = Object.freeze([
  { key: 'recommended_subject',   label_zh: '推荐科目',           type: 'string',   source: 'meta' },
  { key: 'audience',              label_zh: '适合人群 / 人物群像', type: 'string',   source: 'llm'  },
  { key: 'recommended_scenes',    label_zh: '推荐场景',           type: 'string[]', source: 'llm'  },
  { key: 'primary_value',         label_zh: '主要价值',           type: 'string',   source: 'llm'  },
  { key: 'not_for',               label_zh: '不适合谁',           type: 'string',   source: 'llm'  },
  { key: 'prerequisites',         label_zh: '前置知识',           type: 'string[]', source: 'llm'  },
  { key: 'difficulty_level',      label_zh: '难度等级',           type: 'enum',     source: 'algo',
    enum: ['入门', '进阶', '专家', '前沿'] },
  { key: 'cognitive_load',        label_zh: '认知负荷',           type: 'enum',     source: 'algo',
    enum: ['轻', '中', '重', '极重'] },
  { key: 'stability_tag',         label_zh: '稳定性标签',         type: 'enum',     source: 'algo',
    enum: ['稳定', '演化中', '争议', '过时'] },
  { key: 'risks_and_defects',     label_zh: '风险与缺陷',         type: 'string[]', source: 'llm'  },
  { key: 'usage_method',          label_zh: '使用方式',           type: 'string',   source: 'llm'  },
  { key: 'quality_score',         label_zh: '质量评分',           type: 'number',   source: 'algo' }, // 0-100
  { key: 'safety_level',          label_zh: '安全等级',           type: 'enum',     source: 'algo',
    enum: ['safe', 'caution', 'unsafe', 'blocked'] },
  { key: 'why_for_you',           label_zh: '为什么推荐给当前用户', type: 'string',   source: 'algo' },
  { key: 'transferable_to',       label_zh: '可迁移到哪些 Product / Creation', type: 'string[]', source: 'llm' },
]);

/**
 * 8-factor sort weights per BLUEPRINT §12 commons sort order.
 * Sum = 1.0. Quality + safety + learning-effect together = 0.40 (intrinsic);
 * other 4 are contextual (user-state dependent).
 */
const RANK_WEIGHTS = Object.freeze({
  goal_match:            0.20,
  current_lesson:        0.15,
  mastery_fit:           0.10,
  current_product:       0.10,
  quality_score:         0.15,
  safety_score:          0.15,
  learning_effect:       0.10,
  maintenance_state:     0.05,
});

/**
 * Derive difficulty_level algorithmically from syllabus depth + curator
 * tags. Heuristic — overridden by LLM card if richer signal present.
 *
 * @param {object} pack
 * @returns {'入门'|'进阶'|'专家'|'前沿'}
 */
function _deriveDifficulty(pack) {
  const syllabusN = Array.isArray(pack.syllabus_skeleton) ? pack.syllabus_skeleton.length : 0;
  const kpCount = (pack.syllabus_skeleton || []).reduce(
    (sum, c) => sum + (Array.isArray(c.kp_candidates) ? c.kp_candidates.length : 0), 0
  );
  const tags = Array.isArray(pack.tags) ? pack.tags.map(t => String(t).toLowerCase()) : [];
  if (tags.includes('frontier') || tags.includes('research')) return '前沿';
  if (kpCount > 30 || syllabusN > 8) return '专家';
  if (kpCount > 12 || syllabusN > 4) return '进阶';
  return '入门';
}

/**
 * Cognitive load = function of KP density + contested-question count.
 * Pure heuristic over pack meta — independent of user.
 */
function _deriveCognitiveLoad(pack) {
  const kpCount = (pack.syllabus_skeleton || []).reduce(
    (sum, c) => sum + (Array.isArray(c.kp_candidates) ? c.kp_candidates.length : 0), 0
  );
  const contestedN = Array.isArray(pack.contested_questions) ? pack.contested_questions.length : 0;
  const load = kpCount + (contestedN * 2);
  if (load >= 40) return '极重';
  if (load >= 20) return '重';
  if (load >= 8)  return '中';
  return '轻';
}

/**
 * Stability tag from age + ratification + explicit deprecated flag.
 */
function _deriveStability(pack) {
  if (pack.deprecated === true) return '过时';
  const ratifiedMs = Date.parse(pack.ratified_at || '');
  if (Number.isFinite(ratifiedMs)) {
    const ageMo = (Date.now() - ratifiedMs) / (1000 * 60 * 60 * 24 * 30);
    if (ageMo > 18) return '过时';
  }
  const contestedN = Array.isArray(pack.contested_questions) ? pack.contested_questions.length : 0;
  const ratifiedN = Array.isArray(pack.ratified_by) ? pack.ratified_by.length : 0;
  if (contestedN >= 5 && ratifiedN < 3) return '争议';
  if (ratifiedN >= 3) return '稳定';
  return '演化中';
}

/**
 * Quality score 0-100 — algorithmic, NOT user-dependent.
 * Composed of: ratification depth, syllabus completeness, source quality,
 * recency. Higher = better intrinsic quality.
 */
function _computeQualityScore(pack) {
  let score = 0;
  const ratifiedN = Array.isArray(pack.ratified_by) ? pack.ratified_by.length : 0;
  score += Math.min(30, ratifiedN * 8); // ratifications up to 30 pts
  const syllabusN = Array.isArray(pack.syllabus_skeleton) ? pack.syllabus_skeleton.length : 0;
  score += Math.min(20, syllabusN * 4); // syllabus chapters up to 20 pts
  const sourcesN = Array.isArray(pack.recommended_sources) ? pack.recommended_sources.length : 0;
  score += Math.min(20, sourcesN * 4); // sources up to 20 pts
  const contestedN = Array.isArray(pack.contested_questions) ? pack.contested_questions.length : 0;
  score += Math.min(10, contestedN * 2); // contested Qs = pedagogy depth, up to 10
  // Recency — within 12 mo = full 20; older decays
  const ratifiedMs = Date.parse(pack.ratified_at || '');
  if (Number.isFinite(ratifiedMs)) {
    const ageMo = (Date.now() - ratifiedMs) / (1000 * 60 * 60 * 24 * 30);
    const recency = Math.max(0, 20 - Math.max(0, ageMo - 12) * 1.5);
    score += recency;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Build the "why for you" reason string. Uses userContext signals:
 *   - userContext.goal — string ("learn 柏拉图 for 哲学考试")
 *   - userContext.currentLesson — { topic, kp_ids }
 *   - userContext.masteryMap — { [topic]: 0-1 score }
 *   - userContext.products — string[] of active product topics
 */
function getRecommendationReason(pack, userContext = {}) {
  const reasons = [];
  const topic = pack.topic || '';
  const goal = String(userContext.goal || '').toLowerCase();
  const tn = topic.toLowerCase();
  if (goal && (goal.includes(tn) || tn.includes(goal))) {
    reasons.push(`目标 "${userContext.goal}" 直命 ${topic}`);
  }
  if (userContext.currentLesson && userContext.currentLesson.topic) {
    const lt = String(userContext.currentLesson.topic).toLowerCase();
    if (lt.includes(tn) || tn.includes(lt)) {
      reasons.push(`当前课程"${userContext.currentLesson.topic}"同主题`);
    }
  }
  const masteryMap = userContext.masteryMap || {};
  const masteryHit = Object.keys(masteryMap).find(k =>
    String(k).toLowerCase().includes(tn) || tn.includes(String(k).toLowerCase()));
  if (masteryHit && masteryMap[masteryHit] < 0.6) {
    reasons.push(`Mastery 缺口 (${Math.round(masteryMap[masteryHit] * 100)}%)`);
  }
  const products = Array.isArray(userContext.products) ? userContext.products : [];
  const productHit = products.find(p =>
    String(p).toLowerCase().includes(tn) || tn.includes(String(p).toLowerCase()));
  if (productHit) {
    reasons.push(`你的 Product "${productHit}" 可吸收`);
  }
  if (reasons.length === 0) {
    return `候选: ${topic}, 主题距离当前目标较远; 收藏待用即可`;
  }
  return reasons.join(' · ');
}

/**
 * Generate the full Pack Intelligence Card. v0.1 — algorithmic fields
 * are real; LLM-source fields are mocked with deterministic synthesis
 * from pack metadata. Real T4_JUDGE wiring deferred to Wave 7.
 *
 * @param {object} pack — pack.json shape from community.js
 * @param {object} userContext — { goal, currentLesson, masteryMap, products, safetyLevel }
 * @returns {object} card — keyed by PACK_INTELLIGENCE_SCHEMA[].key
 */
function generateCard(pack, userContext = {}) {
  if (!pack || !pack.topic) {
    throw new Error('generateCard: pack.topic required');
  }
  const topic = pack.topic;
  const audience = pack.lang === 'zh'
    ? `对 ${topic} 入门或巩固的中文读者, 偏好 manuscript register`
    : `Readers entering ${topic}, willing to engage with primary sources`;

  // Mocked LLM-derived fields — deterministic from pack meta. Real call
  // would dispatch via executeChat('T4_JUDGE', ...) — see app/lib/llm/.
  const scenes = [
    `预读 ${topic} 主章节前的 prior install`,
    `主题专题 lesson 设计的章节骨架`,
    `争议问题 CHALLENGE 模式 seed`,
  ];
  const primaryValue = `把 ${topic} 的 frontier conversation 浓缩为 ${(pack.syllabus_skeleton || []).length} 章 / ${
    (pack.recommended_sources || []).length} 一手源, 跳过工业化教材的"定义→记忆"路径.`;
  const notFor = `不为 "速通 ${topic} 考点" 的用户 — 本包不优化短期分数. 也不为对争议问题没耐心的读者.`;
  const prereqs = pack.lang === 'zh'
    ? ['基础阅读理解', '愿意接受未解争议而非定论']
    : ['Reading comprehension', 'Comfort with unresolved questions'];
  const risks = [];
  const contestedN = Array.isArray(pack.contested_questions) ? pack.contested_questions.length : 0;
  if (contestedN >= 3) risks.push(`含 ${contestedN} 条争议问题, 易引发 CHALLENGE pipeline 多轮 epoch`);
  const ratifiedN = Array.isArray(pack.ratified_by) ? pack.ratified_by.length : 0;
  if (ratifiedN < 2) risks.push('ratification 浅 (<2 ratifiers); 信号未经多方校验');
  const ratifiedMs = Date.parse(pack.ratified_at || '');
  if (Number.isFinite(ratifiedMs)) {
    const ageMo = (Date.now() - ratifiedMs) / (1000 * 60 * 60 * 24 * 30);
    if (ageMo > 12) risks.push(`已过 ${Math.round(ageMo)} 月, 部分推荐源可能已退场`);
  }
  if (risks.length === 0) risks.push('无显著结构性缺陷; 但所有 commons 包仍受蒸馏 bias 影响');

  const usage = `在 Hypha 内: 创课时引用本包作 syllabus 骨架, 或 chain plan 时挂为 prior install. 不直接搬运原文 — 走 Pack Distiller (蒸馏 corpus, Wave 7+).`;

  const transferableTo = [
    `主题相关的 Product Blueprint (e.g. ${topic} 入门读物 / ${topic} 课程产品)`,
    `Cross-Spark Engine 跨学科 Mining`,
    `Living Note 长期 corpus`,
  ];

  // Algorithmic fields
  const difficulty = _deriveDifficulty(pack);
  const cognitiveLoad = _deriveCognitiveLoad(pack);
  const stability = _deriveStability(pack);
  const quality = _computeQualityScore(pack);
  const safetyLevel = userContext.safetyLevel || 'safe'; // injected by security-layer.js
  const whyForYou = getRecommendationReason(pack, userContext);

  return Object.freeze({
    recommended_subject: topic,
    audience,
    recommended_scenes: scenes,
    primary_value: primaryValue,
    not_for: notFor,
    prerequisites: prereqs,
    difficulty_level: difficulty,
    cognitive_load: cognitiveLoad,
    stability_tag: stability,
    risks_and_defects: risks,
    usage_method: usage,
    quality_score: quality,
    safety_level: safetyLevel,
    why_for_you: whyForYou,
    transferable_to: transferableTo,
    _generated_at: new Date().toISOString(),
    _llm_source: 'mock-v0.1', // Wave 7 = 'T4_JUDGE'
  });
}

/**
 * Score one pack against userContext using all 8 factors, weighted per
 * RANK_WEIGHTS. Returns { score, breakdown } for transparency.
 *
 * Each sub-factor returns 0-1 — final score is weighted sum * 100.
 */
function _scorePack(pack, userContext = {}) {
  const topic = String(pack.topic || '').toLowerCase();

  // Goal match — substring overlap
  let goalMatch = 0;
  const goal = String(userContext.goal || '').toLowerCase();
  if (goal && topic) {
    if (goal === topic) goalMatch = 1.0;
    else if (goal.includes(topic) || topic.includes(goal)) goalMatch = 0.7;
    else {
      const aliases = Array.isArray(pack.aliases) ? pack.aliases.map(a => String(a).toLowerCase()) : [];
      for (const a of aliases) {
        if (a && (goal.includes(a) || a.includes(goal))) { goalMatch = 0.5; break; }
      }
    }
  }

  // Current lesson relevance
  let lessonMatch = 0;
  if (userContext.currentLesson && userContext.currentLesson.topic) {
    const lt = String(userContext.currentLesson.topic).toLowerCase();
    if (lt === topic) lessonMatch = 1.0;
    else if (lt.includes(topic) || topic.includes(lt)) lessonMatch = 0.6;
  }

  // Mastery fit — packs that address user's WEAK areas score higher
  let masteryFit = 0;
  const masteryMap = userContext.masteryMap || {};
  for (const [k, v] of Object.entries(masteryMap)) {
    const kn = String(k).toLowerCase();
    if (kn === topic || kn.includes(topic) || topic.includes(kn)) {
      // weak topic = better fit
      masteryFit = Math.max(masteryFit, 1 - Math.max(0, Math.min(1, Number(v) || 0)));
    }
  }

  // Current product relevance
  let productMatch = 0;
  const products = Array.isArray(userContext.products) ? userContext.products : [];
  for (const p of products) {
    const pn = String(p).toLowerCase();
    if (pn === topic) { productMatch = 1.0; break; }
    if (pn.includes(topic) || topic.includes(pn)) productMatch = Math.max(productMatch, 0.6);
  }

  // Quality score (already 0-100 → normalize)
  const qualityNorm = _computeQualityScore(pack) / 100;

  // Safety — injected by security-layer.js; default 1.0 if not scanned
  const safetyLevelMap = { safe: 1.0, caution: 0.6, unsafe: 0.2, blocked: 0 };
  const safetyLevel = userContext.safetyByPackId
    ? (userContext.safetyByPackId[pack.id] || 'safe')
    : (pack._safety_level || 'safe');
  const safetyNorm = safetyLevelMap[safetyLevel] != null ? safetyLevelMap[safetyLevel] : 1.0;

  // Learning effect — proxied by completeness (syllabus + contested
  // questions = scaffolding for Lesson System hand-off)
  const syllabusN = Array.isArray(pack.syllabus_skeleton) ? pack.syllabus_skeleton.length : 0;
  const contestedN = Array.isArray(pack.contested_questions) ? pack.contested_questions.length : 0;
  const learningEffect = Math.min(1, (syllabusN * 0.15) + (contestedN * 0.1));

  // Maintenance state — recent ratified_at = healthy
  let maintenance = 0.5;
  const ratifiedMs = Date.parse(pack.ratified_at || '');
  if (Number.isFinite(ratifiedMs)) {
    const ageMo = (Date.now() - ratifiedMs) / (1000 * 60 * 60 * 24 * 30);
    if (ageMo < 6) maintenance = 1.0;
    else if (ageMo < 12) maintenance = 0.8;
    else if (ageMo < 18) maintenance = 0.4;
    else maintenance = 0.2;
  }
  if (pack.deprecated === true) maintenance = 0;

  const breakdown = {
    goal_match: goalMatch,
    current_lesson: lessonMatch,
    mastery_fit: masteryFit,
    current_product: productMatch,
    quality_score: qualityNorm,
    safety_score: safetyNorm,
    learning_effect: learningEffect,
    maintenance_state: maintenance,
  };

  let score = 0;
  for (const k of Object.keys(RANK_WEIGHTS)) {
    score += (breakdown[k] || 0) * RANK_WEIGHTS[k];
  }
  return { score: Math.round(score * 100), breakdown };
}

/**
 * Rank packs descending by composite score. Returns enriched packs with
 * `_rank_score` and `_rank_breakdown` for UI display.
 *
 * Blocked packs (safety_level='blocked') drop to bottom regardless of
 * other factors — defense-in-depth alongside security-layer.js.
 */
function rankPacks(packs, userContext = {}) {
  if (!Array.isArray(packs)) return [];
  const enriched = packs.map(p => {
    const { score, breakdown } = _scorePack(p, userContext);
    return Object.assign({}, p, { _rank_score: score, _rank_breakdown: breakdown });
  });
  enriched.sort((a, b) => {
    // Blocked → bottom
    const aSafety = (userContext.safetyByPackId && userContext.safetyByPackId[a.id]) || a._safety_level || 'safe';
    const bSafety = (userContext.safetyByPackId && userContext.safetyByPackId[b.id]) || b._safety_level || 'safe';
    if (aSafety === 'blocked' && bSafety !== 'blocked') return 1;
    if (bSafety === 'blocked' && aSafety !== 'blocked') return -1;
    return b._rank_score - a._rank_score;
  });
  return enriched;
}

module.exports = {
  PACK_INTELLIGENCE_SCHEMA,
  RANK_WEIGHTS,
  generateCard,
  rankPacks,
  getRecommendationReason,
};
